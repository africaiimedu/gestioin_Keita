"""Écoles officielles et année académique en cours."""

from __future__ import annotations

import re
import unicodedata
from datetime import date
from typing import Any

ECOLES = (
    "AFRICAIIM Business School",
    "AFRICAIIM Tech",
    "AFRICAIIM École de Droit et Sciences Politiques",
    "AFRICAIIM Sup de Com",
    "AFRICAIIM Expertise Comptable",
    "AFRICAIIM Carrières Bancaires",
)


def annee_academique_courante(jour: date | None = None) -> str:
    """L'année commence en septembre : le 29/09/2026 donne 2026-2027."""
    jour = jour or date.today()
    debut = jour.year if jour.month >= 9 else jour.year - 1
    return f"{debut}-{debut + 1}"


def _clef(texte: str) -> str:
    normalise = unicodedata.normalize("NFD", texte.strip().casefold())
    sans = "".join(c for c in normalise if unicodedata.category(c) != "Mn")
    return re.sub(r"\s+", " ", sans)


_NIVEAUX = {
    "cpi_1": "1re année",
    "cpi_2": "2e année",
    "miage_1": "1re année",
    "miage_2": "2e année",
    "miage_3": "3e année",
    "bachelor_1": "1re année",
    "bachelor_2": "2e année",
    "bachelor_3": "3e année",
    "master_1": "1re année",
    "master_2": "2e année",
    "licence": "1re année",
    "master": "1re année",
}


def libelle_annee_etude(rang: int) -> str:
    if rang <= 1:
        return "1re année"
    return f"{rang}e année"


def libelle_niveau(valeur: Any = None, *, intake_year: Any = None, duration_years: Any = None) -> str:
    """Libellé imprimé sur la carte et au flash du QR (1re année, 2e année…)."""
    brut = str(valeur or "").strip()
    if brut:
        cle = _clef(brut).replace(" ", "_")
        if cle in _NIVEAUX:
            return _NIVEAUX[cle]
        if brut in _NIVEAUX.values():
            return brut
        try:
            return libelle_annee_etude(int(brut))
        except ValueError:
            if "année" in brut.lower() or "annee" in _clef(brut):
                return brut
    debut = None
    try:
        debut = int(intake_year)
    except (TypeError, ValueError):
        debut = None
    if debut and 2000 <= debut <= 2100:
        courant = int(annee_academique_courante().split("-")[0])
        rang = max(1, courant - debut + 1)
        try:
            duree = int(duration_years) if duration_years is not None else 12
        except (TypeError, ValueError):
            duree = 12
        if duree < 1:
            duree = 12
        return libelle_annee_etude(min(rang, duree))
    return brut


def ecole_officielle(texte: str) -> str:
    clef = _clef(texte or "")
    for nom in ECOLES:
        if _clef(nom) == clef:
            return nom
    raise ValueError("Cette école n'est pas dans la liste AFRICAIIM.")
