"""Premier démarrage : compte administrateur."""

from __future__ import annotations

from sqlalchemy import func, select, text

from app.config import env
from app.database import Base, SessionLocal, engine
from app.models import Etudiant, Utilisateur, maintenant
from app.security import hash_mot_de_passe


def verifier_base() -> None:
    try:
        with engine.connect() as connexion:
            connexion.execute(text("SELECT 1"))
    except Exception as exc:
        raise RuntimeError(
            "PostgreSQL ne répond pas. Ouvrez Docker Desktop, puis dans ce dossier "
            "lancez : docker compose up -d\n"
            f"Détail technique : {exc}"
        ) from exc


def initialiser() -> None:
    Base.metadata.create_all(bind=engine)
    _colonnes_cantine()
    with SessionLocal() as db:
        _assurer_admin(db)
        _assurer_cuisiniere(db)
        _assurer_exemple(db)
        _assurer_cantine_exemple(db)
        _assurer_menu(db)
        _retirer_ecoles_hors_liste(db)


def _colonnes_cantine() -> None:
    with engine.begin() as connexion:
        connexion.execute(text("ALTER TABLE etudiants ADD COLUMN IF NOT EXISTS email VARCHAR(120) DEFAULT ''"))
        connexion.execute(
            text("ALTER TABLE etudiants ADD COLUMN IF NOT EXISTS solde_cantine INTEGER NOT NULL DEFAULT 0")
        )
        connexion.execute(text("ALTER TABLE utilisateurs ADD COLUMN IF NOT EXISTS peut_valider_qr BOOLEAN"))
        connexion.execute(
            text(
                "UPDATE utilisateurs SET peut_valider_qr = TRUE "
                "WHERE peut_valider_qr IS NULL AND role IN ('cuisiniere', 'securite')"
            )
        )
        connexion.execute(text("UPDATE utilisateurs SET peut_valider_qr = FALSE WHERE peut_valider_qr IS NULL"))
        connexion.execute(text("ALTER TABLE utilisateurs ALTER COLUMN peut_valider_qr SET DEFAULT FALSE"))
        connexion.execute(text("ALTER TABLE utilisateurs ALTER COLUMN peut_valider_qr SET NOT NULL"))
        connexion.execute(text("ALTER TABLE utilisateurs ADD COLUMN IF NOT EXISTS pin_cantine_hash VARCHAR(255)"))
        connexion.execute(text("ALTER TABLE plats ADD COLUMN IF NOT EXISTS photo_chemin VARCHAR(120)"))
        connexion.execute(
            text("ALTER TABLE etudiants ADD COLUMN IF NOT EXISTS sexe VARCHAR(1) NOT NULL DEFAULT 'M'")
        )


def _assurer_cantine_exemple(db) -> None:
    etudiant = db.scalar(select(Etudiant).where(Etudiant.matricule == "AIIM-2026-0142"))
    if etudiant is None:
        return
    if (etudiant.email or "") in ("", "amina.diop@africaiim.edu.gn"):
        etudiant.email = "jtoupou@univ-africaiim.com"
    if etudiant.email and etudiant.solde_cantine:
        db.commit()
        return
    if not etudiant.solde_cantine:
        etudiant.solde_cantine = 50000
    db.commit()


def _assurer_admin(db) -> None:
    identifiant = env("ADMIN_IDENTIFIANT", "africaiim").strip().lower()
    existe = db.scalar(
        select(Utilisateur).where(func.lower(Utilisateur.identifiant) == identifiant)
    )
    if existe is None:
        mot_de_passe = env("ADMIN_MOT_DE_PASSE")
        if len(mot_de_passe) < 10:
            raise RuntimeError("ADMIN_MOT_DE_PASSE doit contenir au moins 10 caractères dans le fichier .env.")
        db.add(
            Utilisateur(
                identifiant=identifiant,
                mot_de_passe_hash=hash_mot_de_passe(mot_de_passe),
                role="admin",
                actif=True,
                doit_changer_mot_de_passe=False,
                cree_le=maintenant(),
            )
        )
    elif existe.role != "admin":
        existe.role = "admin"
        existe.actif = True
    ancien = db.scalar(
        select(Utilisateur).where(func.lower(Utilisateur.identifiant) == "scolarite")
    )
    if ancien is not None and ancien.identifiant != identifiant and ancien.role == "admin":
        ancien.role = "scolarite"
    db.commit()


def _assurer_cuisiniere(db) -> None:
    identifiant = env("CUISINIERE_IDENTIFIANT", "cuisiniere").lower()
    existe = db.scalar(
        select(Utilisateur).where(func.lower(Utilisateur.identifiant) == identifiant)
    )
    if existe:
        return
    mot_de_passe = env("CUISINIERE_MOT_DE_PASSE")
    if len(mot_de_passe) < 10:
        raise RuntimeError(
            "CUISINIERE_MOT_DE_PASSE doit contenir au moins 10 caractères dans le fichier .env."
        )
    db.add(
        Utilisateur(
            identifiant=identifiant,
            mot_de_passe_hash=hash_mot_de_passe(mot_de_passe),
            role="cuisiniere",
            actif=True,
            doit_changer_mot_de_passe=True,
            cree_le=maintenant(),
        )
    )
    db.commit()


def _assurer_menu(db) -> None:
    from secrets import token_urlsafe

    from app.models import CategoriePlat, Plat, PointCantine

    if db.scalar(select(PointCantine).limit(1)) is None:
        db.add(PointCantine(nom="Cantine principale", jeton=token_urlsafe(24), actif=True))
        db.commit()
    if db.scalar(select(Plat).limit(1)) is not None:
        return
    groupes = [
        ("Plats chauds", "chauds", [("Thiéboudienne", "Riz au poisson, légumes et sauce tomate.", 25000, "Plat du jour", "bol", 25, None), ("Poulet yassa", "Poulet citronné, oignons confits, riz blanc.", 20000, "Populaire", "bol", 20, None), ("Riz sauce arachide", "Sauce onctueuse, légumes et riz parfumé.", 15000, None, "bol", 20, None), ("Mafé", "Viande mijotée à la pâte d'arachide.", 18000, None, "bol", 25, None)]),
        ("Grillades", "grill", [("Brochettes de bœuf", "Bœuf grillé, oignons et piment doux.", 12000, "Épicé", "grill", 15, 12), ("Poisson braisé", "Poisson entier, marinade et attiéké.", 22000, None, "grill", 20, 8), ("Attiéké poisson", "Semoule de manioc, poisson frit, piment.", 20000, "Populaire", "grill", 15, None)]),
        ("Entrées", "entrees", [("Alloco", "Banane plantain frite, sel et piment.", 5000, "Populaire", "frit", 8, None), ("Fataya", "Beignet farci au poisson.", 3000, None, "frit", 8, None)]),
        ("Végétarien", "vert", [("Salade d'avocat", "Avocat, tomate, oignon et citron.", 8000, "Végétarien", "feuille", 8, None)]),
        ("Desserts", "doux", [("Thiakry", "Couscous sucré, lait caillé et vanille.", 4000, None, "creme", 5, None), ("Beignets", "Pâte frite, un peu sucrée.", 2000, None, "frit", 5, None)]),
        ("Boissons", "boire", [("Jus de bissap", "Fleur d'hibiscus, menthe, peu sucré.", 3000, None, "verre", 3, None), ("Jus de gingembre", "Gingembre frais, citron et ananas.", 3000, "Épicé", "verre", 3, None), ("Formule yassa + bissap", "Poulet yassa et un verre de bissap.", 22000, "Formule", "bol", 20, None)]),
    ]
    ordre_cat = 0
    for nom, slug, plats in groupes:
        ordre_cat += 1
        categorie = CategoriePlat(nom=nom, slug=slug, ordre=ordre_cat)
        db.add(categorie)
        db.flush()
        for index, (titre, description, prix, badge, visuel, temps, stock) in enumerate(plats, start=1):
            db.add(
                Plat(
                    categorie_id=categorie.id,
                    nom=titre,
                    description=description,
                    prix=prix,
                    badge=badge,
                    visuel=visuel,
                    temps_min=temps,
                    stock=stock,
                    disponible=True,
                    ordre=index,
                )
            )
    db.commit()


def _assurer_exemple(db) -> None:
    """Les étudiants arrivent par le site, avec une école de la liste officielle."""
    return


def _retirer_ecoles_hors_liste(db) -> None:
    from sqlalchemy import delete

    from app.config import ROOT
    from app.models import Carte, CommandeCantine, Journal, LigneCommande, MouvementCantine, Utilisateur
    from app.services.ecoles import ECOLES, annee_academique_courante
    from app.services.import_etudiants import validite_par_defaut

    annee = annee_academique_courante()
    fin = validite_par_defaut(annee)
    for etudiant in list(db.scalars(select(Etudiant)).all()):
        if etudiant.filiere not in ECOLES:
            if etudiant.photo_chemin:
                chemin = (ROOT / etudiant.photo_chemin).resolve()
                if ROOT.resolve() in chemin.parents or chemin.parent == ROOT.resolve():
                    chemin.unlink(missing_ok=True)
            commandes = db.scalars(select(CommandeCantine.id).where(CommandeCantine.etudiant_id == etudiant.id)).all()
            if commandes:
                db.execute(delete(LigneCommande).where(LigneCommande.commande_id.in_(commandes)))
                db.execute(delete(CommandeCantine).where(CommandeCantine.id.in_(commandes)))
            db.execute(delete(MouvementCantine).where(MouvementCantine.etudiant_id == etudiant.id))
            db.execute(delete(Journal).where(Journal.etudiant_id == etudiant.id))
            identifiants = [carte.id for carte in etudiant.cartes]
            if identifiants:
                db.execute(delete(Journal).where(Journal.carte_id.in_(identifiants)))
                db.execute(delete(MouvementCantine).where(MouvementCantine.carte_id.in_(identifiants)))
            db.execute(delete(Carte).where(Carte.etudiant_id == etudiant.id))
            db.execute(delete(Utilisateur).where(Utilisateur.etudiant_id == etudiant.id))
            db.delete(etudiant)
            continue
        etudiant.annee_academique = annee
        etudiant.date_validite = fin
        for carte in etudiant.cartes:
            if carte.statut != "remplacee":
                carte.date_validite = fin
    db.commit()
