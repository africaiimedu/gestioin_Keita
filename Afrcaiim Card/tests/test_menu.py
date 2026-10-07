"""Une commande débite une seule fois, et jamais en dessous de zéro."""

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
    Utilisateur,
    maintenant,
)
from app.security import hash_mot_de_passe
from app.seed import _assurer_menu, _colonnes_cantine
from app.services.menu_cantine import RefusCommande, passer_commande

_MATRICULE = "AIIM-MENU-TEST"
_IDENTIFIANT = "test.menu"
_CUISINIERE = "test.menu.cuisine"
_MOT = "Cantine-test-2026"


def _nettoyer() -> None:
    Base.metadata.create_all(bind=engine)
    _colonnes_cantine()
    with SessionLocal() as db:
        etudiant = db.scalar(select(Etudiant).where(Etudiant.matricule == _MATRICULE))
        if etudiant is None:
            db.execute(delete(Utilisateur).where(Utilisateur.identifiant.in_([_IDENTIFIANT, _CUISINIERE])))
            db.execute(delete(Plat).where(Plat.nom == "Soupe test"))
            db.commit()
            return
        commandes = db.scalars(select(CommandeCantine.id).where(CommandeCantine.etudiant_id == etudiant.id)).all()
        if commandes:
            db.execute(delete(LigneCommande).where(LigneCommande.commande_id.in_(commandes)))
            db.execute(delete(CommandeCantine).where(CommandeCantine.id.in_(commandes)))
        db.execute(delete(MouvementCantine).where(MouvementCantine.etudiant_id == etudiant.id))
        db.execute(delete(Journal).where(Journal.etudiant_id == etudiant.id))
        db.execute(delete(Carte).where(Carte.etudiant_id == etudiant.id))
        db.execute(delete(Utilisateur).where(Utilisateur.etudiant_id == etudiant.id))
        db.execute(delete(Utilisateur).where(Utilisateur.identifiant == _CUISINIERE))
        db.execute(delete(Etudiant).where(Etudiant.id == etudiant.id))
        db.execute(delete(Plat).where(Plat.nom == "Soupe test"))
        db.commit()


def _compte(db, solde: int, statut: str = "active") -> tuple[Etudiant, Utilisateur, PointCantine, Plat]:
    etudiant = Etudiant(
        prenom="Mariam",
        nom="Testmenu",
        matricule=_MATRICULE,
        filiere="AFRICAIIM Business School",
        annee_academique="2026-2027",
        date_validite=date(2027, 8, 31),
        email="test.menu@example.com",
        solde_cantine=solde,
        cree_le=maintenant(),
    )
    db.add(etudiant)
    db.flush()
    db.add(
        Carte(
            etudiant_id=etudiant.id,
            jeton="jeton-menu-test-qui-ne-sert-pas",
            statut=statut,
            date_emission=date(2026, 9, 1),
            date_validite=date(2027, 8, 31),
            numero_edition=1,
            cree_le=maintenant(),
        )
    )
    utilisateur = Utilisateur(
        identifiant=_IDENTIFIANT,
        mot_de_passe_hash=hash_mot_de_passe(_MOT),
        role="etudiant",
        actif=True,
        doit_changer_mot_de_passe=False,
        etudiant_id=etudiant.id,
        cree_le=maintenant(),
    )
    db.add(utilisateur)
    db.commit()
    point = db.scalar(select(PointCantine).where(PointCantine.actif.is_(True)))
    plat = db.scalar(select(Plat).where(Plat.nom == "Thiéboudienne"))
    return etudiant, utilisateur, point, plat


def test_debit_unique_solde_et_carte():
    _nettoyer()
    with SessionLocal() as db:
        _assurer_menu(db)
    try:
        with SessionLocal() as db:
            etudiant, utilisateur, point, plat = _compte(db, 30000)
            commande, neuve = passer_commande(
                db, etudiant, utilisateur, point, [(plat.id, 1)], "cle-menu-test-0001", "2468"
            )
            assert neuve is True
            assert commande.montant == 25000
            db.refresh(etudiant)
            assert etudiant.solde_cantine == 5000
            encore, deuxieme = passer_commande(
                db, etudiant, utilisateur, point, [(plat.id, 1)], "cle-menu-test-0001"
            )
            assert deuxieme is False
            assert encore.id == commande.id
            db.refresh(etudiant)
            assert etudiant.solde_cantine == 5000
            try:
                passer_commande(db, etudiant, utilisateur, point, [(plat.id, 1)], "cle-menu-test-0002")
                raise AssertionError("le solde aurait dû refuser")
            except RefusCommande as exc:
                assert "insuffisant" in str(exc).lower()
            db.refresh(etudiant)
            assert etudiant.solde_cantine == 5000
            carte = db.scalar(select(Carte).where(Carte.etudiant_id == etudiant.id))
            carte.statut = "perdue"
            db.commit()
            try:
                passer_commande(db, etudiant, utilisateur, point, [(plat.id, 1)], "cle-menu-test-0003")
                raise AssertionError("une carte perdue aurait dû être refusée")
            except RefusCommande:
                pass
    finally:
        _nettoyer()


def test_page_menu_et_commande():
    _nettoyer()
    try:
        with TestClient(app) as client:
            with SessionLocal() as db:
                _assurer_menu(db)
                _, _, point, plat = _compte(db, 40000)
                jeton = point.jeton
                plat_id = plat.id
            page = client.get("/login")
            jeton_csrf = page.text.split('name="csrf" value="', 1)[1].split('"', 1)[0]
            entre = client.post(
                "/login",
                data={
                    "identifiant": _IDENTIFIANT,
                    "mot_de_passe": _MOT,
                    "csrf": jeton_csrf,
                    "suivant": f"/m/{jeton}",
                },
                follow_redirects=False,
            )
            assert entre.status_code == 303
            assert entre.headers["location"] == f"/m/{jeton}"
            menu = client.get(f"/m/{jeton}")
            assert menu.status_code == 200
            assert "Thiéboudienne" in menu.text
            assert "Bonjour Mariam" in menu.text
            assert 'data-filtre="chauds"' in menu.text
            assert "/static/plats/thieb.jpg" in menu.text
            assert "apercu-recto" not in client.get("/espace").text
            assert "Programme" in client.get("/espace").text
            csrf = menu.text.split('name="csrf" value="', 1)[1].split('"', 1)[0]
            commande = client.post(
                f"/m/{jeton}/commander",
                data={
                    "csrf": csrf,
                    "panier": f'[{{"id": {plat_id}, "qte": 1}}]',
                    "cle": "clehttpmmenutest01",
                    "pin": "1357",
                },
                follow_redirects=False,
            )
            assert commande.status_code == 303, commande.text
            assert commande.headers["location"].startswith("/menu/commande/")
            recu = client.get(commande.headers["location"])
            assert recu.status_code == 200
            assert "A-" in recu.text
            with SessionLocal() as db:
                etudiant = db.scalar(select(Etudiant).where(Etudiant.matricule == _MATRICULE))
                assert etudiant.solde_cantine == 15000
    finally:
        _nettoyer()


def _entrer(client: TestClient, identifiant: str) -> None:
    page = client.get("/login")
    jeton = page.text.split('name="csrf" value="', 1)[1].split('"', 1)[0]
    entre = client.post(
        "/login",
        data={"identifiant": identifiant, "mot_de_passe": _MOT, "csrf": jeton},
        follow_redirects=False,
    )
    assert entre.status_code == 303


def test_etudiant_compte_cuisiniere_menu_qr_stable():
    _nettoyer()
    try:
        with TestClient(app) as client:
            with SessionLocal() as db:
                _assurer_menu(db)
                _compte(db, 20000)
                db.add(
                    Utilisateur(
                        identifiant=_CUISINIERE,
                        mot_de_passe_hash=hash_mot_de_passe(_MOT),
                        role="cuisiniere",
                        actif=True,
                        peut_valider_qr=True,
                        doit_changer_mot_de_passe=False,
                        cree_le=maintenant(),
                    )
                )
                db.commit()
                point = db.scalar(select(PointCantine).where(PointCantine.actif.is_(True)))
                jeton_avant = point.jeton
                categorie = db.scalar(select(CategoriePlat).order_by(CategoriePlat.ordre))

            _entrer(client, _IDENTIFIANT)
            for adresse in ("/admin/etudiants", "/cantine", "/cantine/menu", "/admin"):
                page = client.get(adresse, follow_redirects=False)
                assert page.status_code == 303
                assert page.headers["location"] == "/espace"
            compte = client.get("/espace")
            assert compte.status_code == 200
            assert "Mon compte" in compte.text
            assert "Atelier" not in compte.text
            assert "Étudiants" not in compte.text

            client.post("/logout", data={"csrf": compte.text.split('name="csrf" value="', 1)[1].split('"', 1)[0]})
            _entrer(client, _CUISINIERE)
            for adresse in ("/admin", "/espace", "/admin/etudiants"):
                page = client.get(adresse, follow_redirects=False)
                assert page.status_code == 303
                assert page.headers["location"] == "/cantine"
            edition = client.get("/cantine/menu")
            assert edition.status_code == 200
            assert "Ajouter un repas" in edition.text
            assert "Supprimer" in edition.text
            assert "Prix en GNF" not in edition.text
            assert "/static/plats/thieb.jpg" in edition.text
            csrf = edition.text.split('name="csrf" value="', 1)[1].split('"', 1)[0]
            ajoute = client.post(
                "/cantine/menu",
                data={
                    "csrf": csrf,
                    "nom": "Soupe test",
                    "description": "Plat ajouté pour l'essai",
                    "prix": "7000",
                    "categorie_id": str(categorie.id),
                },
                follow_redirects=False,
            )
            assert ajoute.status_code == 303
            with SessionLocal() as db:
                point = db.scalar(select(PointCantine).where(PointCantine.actif.is_(True)))
                assert point.jeton == jeton_avant
                plat = db.scalar(select(Plat).where(Plat.nom == "Soupe test"))
                assert plat is not None and plat.prix == 7000
                plat_id = plat.id
                categorie_id = plat.categorie_id
            edition = client.get("/cantine/menu")
            csrf = edition.text.split('name="csrf" value="', 1)[1].split('"', 1)[0]
            fiche = client.get(f"/cantine/menu?plat={plat_id}")
            assert "Prix en GNF" in fiche.text and "Nouvelle image" in fiche.text
            from io import BytesIO
            from PIL import Image
            tampon = BytesIO()
            Image.new("RGB", (320, 240), (180, 90, 40)).save(tampon, format="JPEG")
            client.post(
                f"/cantine/plats/{plat_id}",
                data={
                    "csrf": csrf,
                    "nom": "Soupe test",
                    "description": "Prix modifié",
                    "prix": "8000",
                    "categorie_id": str(categorie_id),
                    "disponible": "1",
                },
                files={"image": ("soupe.jpg", tampon.getvalue(), "image/jpeg")},
                follow_redirects=False,
            )
            with SessionLocal() as db:
                point = db.scalar(select(PointCantine).where(PointCantine.actif.is_(True)))
                assert point.jeton == jeton_avant
                plat = db.scalar(select(Plat).where(Plat.id == plat_id))
                assert plat.prix == 8000

            client.post("/logout", data={"csrf": edition.text.split('name="csrf" value="', 1)[1].split('"', 1)[0]})
            _entrer(client, _IDENTIFIANT)
            menu = client.get(f"/m/{jeton_avant}")
            assert menu.status_code == 200
            assert "Soupe test" in menu.text
            assert f"/static/plats/perso/{plat_id}.jpg" in menu.text
            assert "8 000 GNF" in menu.text or "8 000 GNF" in menu.text
            refus = client.post(
                f"/cantine/plats/{plat_id}/retirer",
                data={"csrf": menu.text.split('name="csrf" value="', 1)[1].split('"', 1)[0]},
                follow_redirects=False,
            )
            assert refus.status_code == 303
            assert refus.headers["location"] == "/espace"
            client.post("/logout", data={"csrf": menu.text.split('name="csrf" value="', 1)[1].split('"', 1)[0]})
            _entrer(client, _CUISINIERE)
            edition = client.get("/cantine/menu")
            csrf = edition.text.split('name="csrf" value="', 1)[1].split('"', 1)[0]
            retire = client.post(
                f"/cantine/plats/{plat_id}/retirer",
                data={"csrf": csrf},
                follow_redirects=False,
            )
            assert retire.status_code == 303
            with SessionLocal() as db:
                point = db.scalar(select(PointCantine).where(PointCantine.actif.is_(True)))
                assert point.jeton == jeton_avant
                assert db.get(Plat, plat_id) is None
            from app.config import ROOT
            assert not (ROOT / "static" / "plats" / "perso" / f"{plat_id}.jpg").is_file()
    finally:
        _nettoyer()
