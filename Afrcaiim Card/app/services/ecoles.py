"""Écoles officielles et année académique en cours."""

from __future__ import annotations

import re
import unicodedata
from datetime import date

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


def ecole_officielle(texte: str) -> str:
    clef = _clef(texte or "")
    for nom in ECOLES:
        if _clef(nom) == clef:
            return nom
    raise ValueError("Cette école n'est pas dans la liste AFRICAIIM.")
