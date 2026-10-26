"""Comptes : matricule pour les étudiants de l'atelier, mail professionnel pour le personnel."""

from __future__ import annotations

import re
import unicodedata

from sqlalchemy import func, select

from app.config import env
from app.models import Etudiant, Utilisateur, maintenant
from app.security import hash_mot_de_passe

DOMAINE = "univ-africaiim.com"
ADRESSE = re.compile(r"^[a-z0-9][a-z0-9.-]{0,60}@univ-africaiim\.com$")
ROLES_PUBLICS = ("professeur", "personnel")


def mot_de_passe_depart() -> str:
    return env("ETUDIANT_MOT_DE_PASSE", "Africaiim2026@")


def mots_de_passe_depart() -> tuple[str, ...]:
    actuel = mot_de_passe_depart()
    return tuple(dict.fromkeys((actuel, "Africaiim2026@", "Africaiim2026")))


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


def assurer_compte_etudiant(db, etudiant: Etudiant, mot_de_passe: str | None = None) -> Utilisateur:
    """Chaque fiche de l'atelier a un compte : identifiant = matricule, mot de passe de départ."""
    matricule = (etudiant.matricule or "").strip()
    if not matricule:
        raise ValueError("Le matricule est obligatoire pour créer le compte.")
    compte = db.scalar(select(Utilisateur).where(Utilisateur.etudiant_id == etudiant.id))
    secret = mot_de_passe or mot_de_passe_depart()
    if compte is None:
        pris = db.scalar(select(Utilisateur).where(func.lower(Utilisateur.identifiant) == matricule.lower()))
        if pris is not None:
            if pris.etudiant_id not in (None, etudiant.id):
                raise ValueError(f"Le matricule {matricule} est déjà utilisé comme identifiant.")
            pris.identifiant = matricule
            pris.role = "etudiant"
            pris.actif = True
            pris.etudiant_id = etudiant.id
            if mot_de_passe:
                pris.mot_de_passe_hash = hash_mot_de_passe(secret)
            return pris
        compte = Utilisateur(
            identifiant=matricule,
            mot_de_passe_hash=hash_mot_de_passe(secret),
            role="etudiant",
            actif=True,
            doit_changer_mot_de_passe=False,
            etudiant_id=etudiant.id,
            cree_le=maintenant(),
        )
        db.add(compte)
        db.flush()
        return compte
    if compte.identifiant.lower() != matricule.lower() and _libre(db, matricule.lower(), compte.id):
        compte.identifiant = matricule
    compte.role = "etudiant"
    compte.etudiant_id = etudiant.id
    compte.doit_changer_mot_de_passe = False
    return compte


def aligner_compte(db, etudiant: Etudiant, adresse: str) -> bool:
    """Garde le login sur le matricule. L'adresse professionnelle reste sur la fiche."""
    change = False
    propre = (adresse or "").strip().lower()
    if propre:
        if not ADRESSE.match(propre):
            raise ValueError("L'adresse du compte doit finir par @univ-africaiim.com.")
        if (etudiant.email or "").lower() != propre:
            etudiant.email = propre
            change = True
    avant = db.scalar(select(Utilisateur).where(Utilisateur.etudiant_id == etudiant.id))
    identifiant = avant.identifiant if avant else None
    compte = assurer_compte_etudiant(db, etudiant)
    return change or identifiant != compte.identifiant


def doit_choisir_mot_de_passe(utilisateur: Utilisateur | None) -> bool:
    return bool(utilisateur and utilisateur.role == "etudiant" and utilisateur.doit_changer_mot_de_passe)


def trouver_utilisateur(db, saisie: str) -> Utilisateur | None:
    """Matricule (atelier), identifiant du compte, ou e-mail professionnel."""
    cle = (saisie or "").strip()
    if not cle:
        return None
    minuscule = cle.lower()
    matricule = cle.replace(" ", "").upper()
    etudiant = db.scalar(select(Etudiant).where(func.upper(Etudiant.matricule) == matricule))
    if etudiant is not None:
        compte = db.scalar(select(Utilisateur).where(Utilisateur.etudiant_id == etudiant.id))
        if compte is not None:
            return compte
        return assurer_compte_etudiant(db, etudiant)
    utilisateur = db.scalar(
        select(Utilisateur).where(func.lower(Utilisateur.identifiant) == minuscule)
    )
    if utilisateur is not None:
        return utilisateur
    etudiant = db.scalar(select(Etudiant).where(func.lower(Etudiant.email) == minuscule))
    if etudiant is None:
        return None
    compte = db.scalar(select(Utilisateur).where(Utilisateur.etudiant_id == etudiant.id))
    return compte or assurer_compte_etudiant(db, etudiant)


def inscrire_professionnel(db, email: str, role: str) -> Utilisateur:
    """Professeur ou personnel : adresse @univ-africaiim.com, mot de passe de départ."""
    adresse = (email or "").strip().lower()
    poste = (role or "").strip().lower()
    if not ADRESSE.match(adresse):
        raise ValueError("Utilisez votre adresse professionnelle qui se termine par @univ-africaiim.com.")
    if poste not in ROLES_PUBLICS:
        raise ValueError("Choisissez professeur ou personnel.")
    if db.scalar(select(Etudiant.id).where(func.lower(Etudiant.email) == adresse)):
        raise ValueError("Cette adresse appartient à un étudiant. Connectez-vous avec le matricule.")
    if db.scalar(select(Etudiant.id).where(func.upper(Etudiant.matricule) == adresse.upper())):
        raise ValueError("Cette adresse ne peut pas servir de compte professionnel.")
    if not _libre(db, adresse):
        raise ValueError("Un compte existe déjà pour cette adresse. Connectez-vous.")
    compte = Utilisateur(
        identifiant=adresse,
        mot_de_passe_hash=hash_mot_de_passe(mot_de_passe_depart()),
        role=poste,
        actif=True,
        doit_changer_mot_de_passe=False,
        cree_le=maintenant(),
    )
    db.add(compte)
    db.commit()
    db.refresh(compte)
    return compte
