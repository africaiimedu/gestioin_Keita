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
    brut = str(valeur or "").strip()
    if not brut:
        return None
    try:
        nombre = int(brut)
    except ValueError:
        nombre = None
    if nombre is not None and 1 <= nombre <= 5:
        return nombre
    cle = _clef(brut).replace("année", " ").replace("annee", " ")
    compact = cle.replace(" ", "").replace("_", "")
    for motif, rang in (("bachelor3", 3), ("licence3", 3), ("b3", 3), ("l3", 3), ("bachelor2", 2), ("licence2", 2), ("b2", 2), ("l2", 2), ("bachelor1", 1), ("licence1", 1), ("b1", 1), ("l1", 1)):
        if motif in compact:
            return rang
    for mot in reversed(cle.replace("_", " ").split()):
        if mot in _RANGS_TEXTE:
            return _RANGS_TEXTE[mot]
    return None


def meilleur_niveau(*textes: Any, intake_year: Any = None, duration_years: Any = None, programme: Any = None, au: date | None = None) -> str:
    """Garde l'année d'études la plus avancée : API, fiche déjà connue, ou année d'entrée."""
    cycle = _cycle_depuis(str(programme or ""), duration_years)
    rangs: list[int] = []
    for texte in textes:
        brut = str(texte or "").strip()
        if not brut:
            continue
        if not cycle:
            low = _clef(brut).replace(" ", "_")
            if low.startswith("master"):
                cycle = "master"
            elif low.startswith(("cpi", "preparatoire")):
                cycle = "cpi"
            elif low.startswith("miage"):
                cycle = "miage"
            elif low.startswith(("bachelor", "licence")):
                cycle = "bachelor"
        rang = _rang_depuis(brut)
        if rang:
            rangs.append(rang)
    extra = rang_depuis_entree(intake_year, duration_years, au)
    if extra:
        rangs.append(extra)
    rang = max(rangs) if rangs else None
    if cycle and rang:
        return libelle_cycle_annee(cycle, rang)
    if cycle:
        return libelle_cycle_annee(cycle, 1)
    if rang:
        return libelle_annee_etude(rang)
    for texte in textes:
        brut = str(texte or "").strip()
        if brut:
            return brut
    return ""


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


def rang_depuis_entree(intake_year: Any, duration_years: Any = None, jour: date | None = None) -> int | None:
    """Année d'études : entrée 2025 en 2026-2027 → 2e année (Bachelor 2)."""
    try:
        debut = int(intake_year)
    except (TypeError, ValueError):
        return None
    if debut < 2000 or debut > 2100:
        return None
    courant = int(annee_academique_courante(jour).split("-")[0])
    rang = max(1, courant - debut + 1)
    try:
        duree = int(duration_years) if duration_years is not None else 12
    except (TypeError, ValueError):
        duree = 12
    if duree < 1:
        duree = 12
    return min(rang, duree)


def libelle_niveau(
    valeur: Any = None,
    *,
    intake_year: Any = None,
    duration_years: Any = None,
    programme: Any = None,
    au: date | None = None,
) -> str:
    """Libellé sur la fiche et la carte : Master 1, Bachelor 2e année…"""
    return meilleur_niveau(
        valeur,
        intake_year=intake_year,
        duration_years=duration_years,
        programme=programme,
        au=au,
    )


def niveau_sur_carte(etu: Any, jour: date | None = None) -> str:
    """Texte imprimé : ne jamais redescendre en 1re année si la fiche ou l'entrée indiquent la 2e."""
    annee = str(getattr(etu, "annee_academique", None) or "").strip()
    debut = None
    if re.match(r"^20\d{2}-\d{4}$", annee):
        debut = int(annee[:4])
    programme = getattr(etu, "programme", None) or getattr(etu, "filiere", None) or ""
    libelle = meilleur_niveau(
        getattr(etu, "niveau", None),
        intake_year=debut,
        programme=programme,
        au=jour,
    )
    return libelle or annee


def ecole_officielle(texte: str) -> str:
    clef = _clef(texte or "")
    for nom in ECOLES:
        if _clef(nom) == clef:
            return nom
    raise ValueError("Cette école n'est pas dans la liste AFRICAIIM.")
