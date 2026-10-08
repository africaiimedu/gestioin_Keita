"""Efface tous les étudiants côté Cartes : fiches, comptes étudiants, cartes, cantine, photos et courriers.

Garde les comptes du personnel, le menu, les points cantine, les postes d'impression et le reste du journal.
Usage : .venv/bin/python remise_a_zero_etudiants.py [--appliquer]
Lancé par scripts/remise-a-zero-etudiants.js ; sans --appliquer, rien n'est modifié.
"""

from __future__ import annotations

import sys

from sqlalchemy import delete, func, inspect, or_, select, text

from app.config import ROOT
from app.database import SessionLocal
from app.models import (
    Carte,
    CommandeCantine,
    Etudiant,
    Journal,
    LigneCommande,
    MouvementCantine,
    RecuCantine,
    TravailImpression,
    Utilisateur,
)

VIDEES = [TravailImpression, RecuCantine, LigneCommande, CommandeCantine, MouvementCantine, Carte]
DOSSIERS = [ROOT / "data" / "photos", ROOT / "data" / "courriers"]


def fichiers() -> list:
    return [f for dossier in DOSSIERS if dossier.is_dir() for f in dossier.iterdir() if f.is_file() and not f.name.startswith(".")]


def main(appliquer: bool) -> None:
    with SessionLocal() as db:
        presentes = set(inspect(db.get_bind()).get_table_names())
        videes = [modele for modele in VIDEES if modele.__tablename__ in presentes]
        comptes = select(Utilisateur.id).where(or_(Utilisateur.role == "etudiant", Utilisateur.etudiant_id.is_not(None)))
        journal = or_(Journal.etudiant_id.is_not(None), Journal.carte_id.is_not(None), Journal.utilisateur_id.in_(comptes))
        compte = {modele.__tablename__: db.scalar(select(func.count()).select_from(modele)) for modele in [*videes, Etudiant]}
        compte["comptes étudiants"] = db.scalar(select(func.count()).select_from(comptes.subquery()))
        compte["journal (lignes étudiants)"] = db.scalar(select(func.count(Journal.id)).where(journal))
        compte["photos et courriers"] = len(fichiers())
        print("Cartes :", " · ".join(f"{nom} {n}" for nom, n in compte.items()))
        if not appliquer:
            print("Aperçu seulement. Ajoutez --appliquer pour tout effacer.")
            return
        db.execute(delete(Journal).where(journal))
        for modele in videes:
            db.execute(delete(modele))
        db.execute(delete(Utilisateur).where(Utilisateur.id.in_(comptes)))
        db.execute(delete(Etudiant))
        for modele in [*videes, Etudiant]:
            db.execute(text(f"SELECT setval(pg_get_serial_sequence('{modele.__tablename__}', 'id'), 1, false)"))
        db.commit()
    retires = 0
    for fichier in fichiers():
        fichier.unlink(missing_ok=True)
        retires += 1
    print(f"Cartes effacées. Photos et courriers retirés : {retires}.")


if __name__ == "__main__":
    main("--appliquer" in sys.argv)
