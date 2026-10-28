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
    "cpi_1": "CPI 1",
    "cpi_2": "CPI 2",
    "miage_1": "MIAGE 1",
    "miage_2": "MIAGE 2",
    "miage_3": "MIAGE 3",
    "bachelor_1": "Bachelor 1ère année",
    "bachelor_2": "Bachelor 2e année",
    "bachelor_3": "Bachelor 3e année",
    "bachelor": "Bachelor 1ère année",
    "licence": "Bachelor 1ère année",
    "master_1": "Master 1",
    "master_2": "Master 2",
    "master": "Master 1",
}

_RANGS_TEXTE = {
    "1": 1, "1re": 1, "1ere": 1, "premiere": 1,
    "2": 2, "2e": 2, "2eme": 2, "deuxieme": 2,
    "3": 3, "3e": 3, "3eme": 3, "troisieme": 3,
}


def libelle_annee_etude(rang: int) -> str:
    if rang <= 1:
        return "1re année"
    return f"{rang}e année"


def _cycle_depuis(programme: str = "", duration_years: Any = None) -> str:
    texte = _clef(programme or "")
    if "miage" in texte:
        return "miage"
    if "cpi" in texte or "preparatoire" in texte:
        return "cpi"
    if "master" in texte:
        return "master"
    if "bachelor" in texte or "licence" in texte:
        return "bachelor"
    try:
        duree = int(duration_years)
    except (TypeError, ValueError):
        return ""
    if duree == 2:
        return "master"
    if duree == 5:
        return "cpi"
    if 3 <= duree <= 4:
        return "bachelor"
    return ""


def _rang_depuis(valeur: str) -> int | None:
    cle = _clef(valeur).replace("année", " ").replace("annee", " ")
    for mot in reversed(cle.replace("_", " ").split()):
        if mot in _RANGS_TEXTE:
            return _RANGS_TEXTE[mot]
    try:
        nombre = int(str(valeur).strip())
    except ValueError:
        return None
    if 1 <= nombre <= 5:
        return nombre
    return None


def libelle_cycle_annee(cycle: str, rang: int) -> str:
    if cycle == "master":
        return f"Master {max(1, min(rang, 2))}"
    if cycle == "cpi":
        return f"CPI {max(1, min(rang, 2))}"
    if cycle == "miage":
        return f"MIAGE {max(1, min(rang, 3))}"
    if rang <= 1:
        return "Bachelor 1ère année"
    return f"Bachelor {rang}e année"


def libelle_niveau(
    valeur: Any = None,
    *,
    intake_year: Any = None,
    duration_years: Any = None,
    programme: Any = None,
) -> str:
    """Libellé sur la fiche d'identité : Master 1, Bachelor 1ère année…"""
    brut = str(valeur or "").strip()
    if brut:
        cle = _clef(brut).replace(" ", "_")
        if cle in _NIVEAUX:
            return _NIVEAUX[cle]
        if brut in _NIVEAUX.values():
            return brut
        low = _clef(brut)
        if low.startswith(("master ", "master_")) and _rang_depuis(brut):
            return libelle_cycle_annee("master", _rang_depuis(brut) or 1)
        if low.startswith(("bachelor ", "bachelor_")) and _rang_depuis(brut):
            return libelle_cycle_annee("bachelor", _rang_depuis(brut) or 1)
    rang = _rang_depuis(brut) if brut else None
    if rang is None:
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
            rang = min(rang, duree)
    cycle = _cycle_depuis(str(programme or ""), duration_years)
    if cycle and rang:
        return libelle_cycle_annee(cycle, rang)
    if cycle:
        return libelle_cycle_annee(cycle, 1)
    if rang:
        return libelle_annee_etude(rang)
    return brut


def ecole_officielle(texte: str) -> str:
    clef = _clef(texte or "")
    for nom in ECOLES:
        if _clef(nom) == clef:
            return nom
    raise ValueError("Cette école n'est pas dans la liste AFRICAIIM.")
