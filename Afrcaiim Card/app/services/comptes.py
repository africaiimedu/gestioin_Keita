"""Comptes des étudiants : adresse prenom.nom@univ-africaiim.com et mot de passe de départ.

La scolarité attribue l'adresse et l'envoie avec l'inscription ; la règle ci-dessous ne sert
que pour une fiche créée directement dans les cartes.
"""

from __future__ import annotations

import re
import unicodedata

from sqlalchemy import func, select

from app.config import env
from app.models import Etudiant, Utilisateur, maintenant
from app.security import hash_mot_de_passe

DOMAINE = "univ-africaiim.com"
ADRESSE = re.compile(r"^[a-z0-9][a-z0-9.-]{0,60}@univ-africaiim\.com$")


def mot_de_passe_depart() -> str:
    return env("ETUDIANT_MOT_DE_PASSE", "Africaiim2026")


def _mots(valeur: str) -> list[str]:
    texte = unicodedata.normalize("NFD", valeur or "")
    texte = "".join(c for c in texte if unicodedata.category(c) != "Mn").lower()
    texte = texte.replace("'", "").replace("’", "")
    return [mot.strip("-") for mot in re.split(r"[^a-z0-9-]+", texte) if mot.strip("-")]


def _plus_court(mots: list[str]) -> str:
    utiles = [mot for mot in mots if len(mot.replace("-", "")) >= 3] or mots
    return min(utiles, key=len)


def _libre(db, adresse: str, sauf_id: int | None = None) -> bool:
    autre = db.scalar(select(Utilisateur).where(func.lower(Utilisateur.identifiant) == adresse))
    return autre is None or autre.id == sauf_id


def adresse_compte(db, prenom: str, nom: str) -> str | None:
    prenoms, noms = _mots(prenom), _mots(nom)
    if not prenoms or not noms:
        return None
    base = f"{_plus_court(prenoms)}.{_plus_court(noms)}"
    rang = 1
    while not _libre(db, f"{base}{rang if rang > 1 else ''}@{DOMAINE}"):
        rang += 1
    return f"{base}{rang if rang > 1 else ''}@{DOMAINE}"


def aligner_compte(db, etudiant: Etudiant, adresse: str) -> bool:
    """Le compte de l'étudiant prend l'adresse donnée par la scolarité. Renvoie True s'il a changé.

    Un compte jamais utilisé repart du mot de passe de départ ; un mot de passe déjà choisi est gardé.
    """
    compte = db.scalar(select(Utilisateur).where(Utilisateur.etudiant_id == etudiant.id))
    if not _libre(db, adresse, compte.id if compte else None):
        raise ValueError(f"L'adresse {adresse} est déjà utilisée par un autre compte.")
    if compte is None:
        db.add(
            Utilisateur(
                identifiant=adresse,
                mot_de_passe_hash=hash_mot_de_passe(mot_de_passe_depart()),
                role="etudiant",
                actif=True,
                doit_changer_mot_de_passe=True,
                etudiant_id=etudiant.id,
                cree_le=maintenant(),
            )
        )
        return True
    if compte.identifiant.lower() == adresse:
        return False
    compte.identifiant = adresse
    if compte.doit_changer_mot_de_passe:
        compte.mot_de_passe_hash = hash_mot_de_passe(mot_de_passe_depart())
    return True


def doit_choisir_mot_de_passe(utilisateur: Utilisateur | None) -> bool:
    return bool(utilisateur and utilisateur.role == "etudiant" and utilisateur.doit_changer_mot_de_passe)
