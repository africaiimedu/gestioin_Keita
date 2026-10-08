"""Sans solde : prix caisse, encaissement par la cuisine, reçu imprimable et rapport."""

from datetime import date

from fastapi.testclient import TestClient
from sqlalchemy import delete, select

from app.database import Base, SessionLocal, engine
from app.main import app
from app.models import (
    Carte,
    CategoriePlat,
    CommandeCantine,
    Etudiant,
    Journal,
    LigneCommande,
    MouvementCantine,
    Plat,
    PointCantine,
    RecuCantine,
    Utilisateur,
    maintenant,
)
from app.security import hash_mot_de_passe
from app.seed import _assurer_menu, _colonnes_cantine
from app.services.cantine import crediter
from app.services.menu_cantine import (
    RefusCommande,
    annuler_commande,
    encaisser_commande,
    passer_commande,
    refuser_commande,
    retirer_plat,
)
from app.services.recus import rapport

_MATRICULES = ("AIIM-RECU-TEST", "AIIM-RECU-AUTRE")
_IDENTIFIANTS = ("test.recu", "test.recu.autre", "test.recu.cuisine")
_PLAT = "Plat reçu test"
_MOT = "Cantine-recu-2026"


def _nettoyer() -> None:
    Base.metadata.create_all(bind=engine)
    _colonnes_cantine()
    with SessionLocal() as db:
        for matricule in _MATRICULES:
            etudiant = db.scalar(select(Etudiant).where(Etudiant.matricule == matricule))
            if etudiant is None:
                continue
            commandes = db.scalars(select(CommandeCantine.id).where(CommandeCantine.etudiant_id == etudiant.id)).all()
            db.execute(delete(RecuCantine).where(RecuCantine.etudiant_id == etudiant.id))
            if commandes:
                db.execute(delete(RecuCantine).where(RecuCantine.commande_id.in_(commandes)))
                db.execute(delete(LigneCommande).where(LigneCommande.commande_id.in_(commandes)))
                db.execute(delete(CommandeCantine).where(CommandeCantine.id.in_(commandes)))
            db.execute(delete(MouvementCantine).where(MouvementCantine.etudiant_id == etudiant.id))
            db.execute(delete(Journal).where(Journal.etudiant_id == etudiant.id))
            db.execute(delete(Carte).where(Carte.etudiant_id == etudiant.id))
            db.execute(delete(Utilisateur).where(Utilisateur.etudiant_id == etudiant.id))
            db.execute(delete(Etudiant).where(Etudiant.id == etudiant.id))
        db.execute(delete(Utilisateur).where(Utilisateur.identifiant.in_(_IDENTIFIANTS)))
        db.execute(delete(Plat).where(Plat.nom == _PLAT))
        db.commit()


def _etudiant(db, matricule: str, identifiant: str, solde: int) -> tuple[Etudiant, Utilisateur]:
    etudiant = Etudiant(
        prenom="Kadiatou",
        nom="Testrecu",
        matricule=matricule,
        filiere="AFRICAIIM Business School",
        annee_academique="2026-2027",
        date_validite=date(2027, 8, 31),
        email="",
        solde_cantine=solde,
        cree_le=maintenant(),
    )
    db.add(etudiant)
    db.flush()
    db.add(
        Carte(
            etudiant_id=etudiant.id,
            jeton=f"jeton-{matricule.lower()}",
            statut="active",
            date_emission=date(2026, 9, 1),
            date_validite=date(2027, 8, 31),
            numero_edition=1,
            cree_le=maintenant(),
        )
    )
    utilisateur = Utilisateur(
        identifiant=identifiant,
        mot_de_passe_hash=hash_mot_de_passe(_MOT),
        role="etudiant",
        actif=True,
        doit_changer_mot_de_passe=False,
        etudiant_id=etudiant.id,
        cree_le=maintenant(),
    )
    db.add(utilisateur)
    db.commit()
    return etudiant, utilisateur


def _plat(db) -> Plat:
    categorie = db.scalar(select(CategoriePlat).order_by(CategoriePlat.ordre))
    plat = Plat(
        categorie_id=categorie.id,
        nom=_PLAT,
        description="",
        prix=10000,
        prix_sans_solde=12000,
        visuel="bol",
        temps_min=10,
        stock=None,
        disponible=True,
        ordre=99,
    )
    db.add(plat)
    db.commit()
    return plat


def _entrer(client: TestClient, identifiant: str) -> str:
    page = client.get("/login")
    jeton = page.text.split('name="csrf" value="', 1)[1].split('"', 1)[0]
    entre = client.post(
        "/login",
        data={"identifiant": identifiant, "mot_de_passe": _MOT, "csrf": jeton},
        follow_redirects=False,
    )
    assert entre.status_code == 303
    return jeton


def test_sans_solde_encaissement_recus_et_rapport():
    _nettoyer()
    with SessionLocal() as db:
        _assurer_menu(db)
    try:
        with SessionLocal() as db:
            etudiant, utilisateur = _etudiant(db, _MATRICULES[0], _IDENTIFIANTS[0], 0)
            point = db.scalar(select(PointCantine).where(PointCantine.actif.is_(True)))
            plat = _plat(db)
            avant = rapport(db, date.today(), date.today())

            commande, _ = passer_commande(db, etudiant, utilisateur, point, [(plat.id, 1)], "cle-recu-test-00001", "1234")
            assert (commande.statut, commande.mode_paiement, commande.montant) == ("a_payer", "caisse", 12000)
            db.refresh(etudiant)
            assert etudiant.solde_cantine == 0
            assert db.scalar(select(RecuCantine).where(RecuCantine.commande_id == commande.id)) is None

            recu = encaisser_commande(db, commande.id, "especes", None)
            assert recu.numero.startswith("RC-")
            assert (recu.nature, recu.mode, recu.montant, recu.matricule) == ("commande", "especes", 12000, _MATRICULES[0])
            assert "1 × Plat reçu test" in recu.details
            db.refresh(commande)
            assert commande.statut == "recue"
            assert encaisser_commande(db, commande.id, "orange_money", None).id == recu.id

            retiree, _ = passer_commande(db, etudiant, utilisateur, point, [(plat.id, 2)], "cle-recu-test-00002")
            refuser_commande(db, retiree.id, None)
            db.refresh(retiree)
            assert retiree.statut == "annulee"
            try:
                encaisser_commande(db, retiree.id, "especes", None)
                raise AssertionError("une commande retirée ne s'encaisse pas")
            except RefusCommande:
                pass

            crediter(db, etudiant, 30000, None)
            recharge = db.scalar(
                select(RecuCantine).where(RecuCantine.etudiant_id == etudiant.id, RecuCantine.nature == "recharge")
            )
            assert (recharge.mode, recharge.montant, recharge.solde_apres) == ("versement", 30000, 30000)

            payee, _ = passer_commande(db, etudiant, utilisateur, point, [(plat.id, 1)], "cle-recu-test-00003")
            assert (payee.statut, payee.mode_paiement, payee.montant) == ("recue", "solde", 10000)
            recu_solde = db.scalar(select(RecuCantine).where(RecuCantine.commande_id == payee.id))
            assert (recu_solde.mode, recu_solde.solde_apres) == ("solde", 20000)

            annuler_commande(db, payee, etudiant)
            db.refresh(recu_solde)
            db.refresh(etudiant)
            assert recu_solde.annule_le is not None
            assert etudiant.solde_cantine == 30000

            apres = rapport(db, date.today(), date.today())
            assert apres["especes"][0] - avant["especes"][0] == 12000
            assert apres["solde"][0] - avant["solde"][0] == 0
            assert apres["recharges"][0] - avant["recharges"][0] == 30000
            assert apres["recu"] - avant["recu"] == 42000
            assert apres["depense"] - avant["depense"] == 12000
            ligne = next(item for item in apres["plats"] if item["nom"] == _PLAT)
            assert (ligne["quantite"], ligne["montant"]) == (1, 12000)
            recu_id = recu.id
            recu_numero = recu.numero

            retirer_plat(db, plat.id)
            garde = db.get(RecuCantine, recu_id)
            assert garde is not None and garde.annule_le is None and "1 × Plat reçu test" in garde.details
            sans_plat = rapport(db, date.today(), date.today())
            assert sans_plat["especes"] == apres["especes"] and sans_plat["plats"] == apres["plats"]
    except BaseException:
        _nettoyer()
        raise

    try:
        with TestClient(app) as client:
            with SessionLocal() as db:
                _etudiant(db, _MATRICULES[1], _IDENTIFIANTS[1], 0)
                db.add(
                    Utilisateur(
                        identifiant=_IDENTIFIANTS[2],
                        mot_de_passe_hash=hash_mot_de_passe(_MOT),
                        role="cuisiniere",
                        actif=True,
                        peut_valider_qr=True,
                        doit_changer_mot_de_passe=False,
                        cree_le=maintenant(),
                    )
                )
                db.commit()

            _entrer(client, _IDENTIFIANTS[0])
            liste = client.get("/menu/recus")
            assert liste.status_code == 200 and recu_numero in liste.text
            page = client.get(f"/menu/recus/{recu_id}")
            assert page.status_code == 200
            assert "Imprimer le reçu" in page.text and "Espèces" in page.text and "12.000 GNF" in page.text
            client.post("/logout", data={"csrf": page.text.split('name="csrf" value="', 1)[1].split('"', 1)[0]})

            _entrer(client, _IDENTIFIANTS[1])
            interdit = client.get(f"/menu/recus/{recu_id}", follow_redirects=False)
            assert interdit.status_code == 303 and interdit.headers["location"] == "/menu/recus"
            assert client.get("/cantine/rapport", follow_redirects=False).status_code == 303
            autre = client.get("/menu/recus")
            client.post("/logout", data={"csrf": autre.text.split('name="csrf" value="', 1)[1].split('"', 1)[0]})

            _entrer(client, _IDENTIFIANTS[2])
            assert client.get(f"/cantine/recus/{recu_id}").status_code == 200
            jour = client.get("/cantine/recus")
            assert jour.status_code == 200 and recu_numero in jour.text
            bilan = client.get("/cantine/rapport")
            assert bilan.status_code == 200 and "Reçu (argent entré)" in bilan.text and _PLAT in bilan.text
            menu = client.get("/cantine/menu")
            assert "sans solde" in menu.text
    finally:
        _nettoyer()
