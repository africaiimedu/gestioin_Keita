"""Synchronisation des étudiants depuis l'API Université AFRICAIIM.

La base atelier ne garde que les étudiants renvoyés par l'API Université
qui existent aussi dans les comptes étudiants de la scolarité.
La validité suit la durée du programme.
"""

from __future__ import annotations

import logging
import re
import time
from datetime import date
from typing import Any
from urllib.parse import urljoin

import httpx
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import env
from app.models import Etudiant
from app.services.import_etudiants import controler_fiche
from app.services.metier import carte_courante, creer_etudiant, modifier_etudiant, remplacer_photo, supprimer_etudiant
from app.services.photos import normaliser_photo

journal = logging.getLogger(__name__)

PAGE_SIZE = 100
TIMEOUT = 45.0


def api_configuree() -> bool:
    return bool(env("UNIVERSITE_API_KEY"))


def _base() -> str:
    return env("UNIVERSITE_API_URL", "https://api.universite-africaiim.com").rstrip("/") + "/"


def _entetes() -> dict[str, str]:
    cle = env("UNIVERSITE_API_KEY")
    if not cle:
        raise RuntimeError(
            "UNIVERSITE_API_KEY est absent du fichier .env des cartes. "
            "Ajoutez la clé API Université pour synchroniser les étudiants."
        )
    return {
        "Authorization": f"Api-Key {cle}",
        "Accept": "application/json",
        "Accept-Language": "fr",
    }


def _entier(valeur: Any, defaut: int | None = None) -> int | None:
    try:
        nombre = int(valeur)
    except (TypeError, ValueError):
        return defaut
    return nombre


def annee_academique_api(intake_year: Any) -> str | None:
    annee = _entier(intake_year)
    if annee is None or annee < 2000 or annee > 2100:
        return None
    return f"{annee}-{annee + 1}"


def date_validite_api(intake_year: Any, duration_years: Any) -> date | None:
    """Fin de validité = 31/08 de (année d'entrée + durée du programme).

    Ex. entrée 2026, Bachelor 3 ans → 31/08/2029.
    """
    debut = _entier(intake_year)
    duree = _entier(duration_years, 1)
    if debut is None or duree is None or duree < 1 or duree > 12:
        return None
    if debut < 2000 or debut > 2100:
        return None
    return date(debut + duree, 8, 31)


def _repartir_nom_prenom(prenom: str, nom: str) -> tuple[str, str]:
    """L'API laisse parfois le nom vide (tout dans first_name) : on répartit proprement."""
    prenom = re.sub(r"\s+", " ", (prenom or "")).strip()
    nom = re.sub(r"\s+", " ", (nom or "")).strip()
    if prenom and nom:
        return prenom, nom
    if nom and not prenom:
        parties = nom.split(" ")
        if len(parties) >= 2:
            return " ".join(parties[:-1]), parties[-1]
        return nom, nom
    if prenom and not nom:
        parties = prenom.split(" ")
        if len(parties) >= 2:
            return " ".join(parties[:-1]), parties[-1]
        # Un seul mot : on le duplique pour respecter le contrôle fiche (nom obligatoire).
        return prenom, prenom
    return prenom, nom


def fiche_depuis_api(brut: dict) -> dict:
    """Transforme une fiche API en champs atelier (100 % source Université)."""
    matricule = str(brut.get("student_number") or "").strip()
    prenom, nom = _repartir_nom_prenom(
        str(brut.get("first_name") or ""),
        str(brut.get("last_name") or ""),
    )
    ecole = str(brut.get("school") or "").strip()
    email = str(brut.get("institutional_email") or brut.get("email") or "").strip()
    annee = annee_academique_api(brut.get("intake_year")) or ""
    validite = date_validite_api(brut.get("intake_year"), brut.get("duration_years"))
    photo_url = str(brut.get("photo_url") or "").strip()
    programme = str(brut.get("programme") or "").strip()
    duree = _entier(brut.get("duration_years"), 1) or 1
    return {
        "matricule": matricule,
        "prenom": prenom,
        "nom": nom,
        "ecole": ecole,
        "email": email,
        "annee": annee,
        "date_validite": validite,
        "duree_ans": duree,
        "programme": programme,
        "photo_url": photo_url,
        "statut": str(brut.get("status") or "").strip().lower(),
    }


def lister_etudiants(client: httpx.Client | None = None) -> list[dict]:
    """Toutes les pages de GET /api/academics/staff/students/."""
    propre = client is None
    http = client or httpx.Client(timeout=TIMEOUT, headers=_entetes(), follow_redirects=True)
    try:
        url = urljoin(_base(), "api/academics/staff/students/")
        params: dict[str, Any] = {"page_size": PAGE_SIZE}
        resultats: list[dict] = []
        vus: set[str] = set()
        while url:
            reponse = http.get(url, params=params)
            reponse.raise_for_status()
            data = reponse.json()
            page = data.get("results") if isinstance(data, dict) else data
            if not isinstance(page, list):
                raise RuntimeError("Réponse API étudiants inattendue (pas de liste results).")
            for item in page:
                if not isinstance(item, dict):
                    continue
                cle = str(item.get("id") or item.get("student_number") or "")
                if cle and cle in vus:
                    continue
                if cle:
                    vus.add(cle)
                resultats.append(item)
            suivant = data.get("next") if isinstance(data, dict) else None
            url = suivant if isinstance(suivant, str) and suivant else None
            params = None
        return resultats
    finally:
        if propre:
            http.close()


def telecharger_photo(url: str, client: httpx.Client | None = None) -> bytes | None:
    if not url or not url.startswith(("http://", "https://")):
        return None
    propre = client is None
    http = client or httpx.Client(timeout=TIMEOUT, headers=_entetes(), follow_redirects=True)
    try:
        reponse = http.get(url)
        if reponse.status_code != 200 or not reponse.content:
            return None
        return normaliser_photo(reponse.content)
    except Exception as exc:
        journal.warning("Photo Université illisible (%s) : %s", url[:80], exc)
        return None
    finally:
        if propre:
            http.close()


def _matricule_cle(valeur: str) -> str:
    return re.sub(r"\s+", "", str(valeur or "")).upper()


_cache_validites: dict[str, Any] = {"jusqua": 0.0, "table": {}}


def vider_cache_validites() -> None:
    _cache_validites["jusqua"] = 0.0
    _cache_validites["table"] = {}


def validites_programmes() -> dict[str, date]:
    """Matricule → fin de programme (31/08), lu dans l'API et gardé dix minutes."""
    maintenant = time.monotonic()
    if maintenant < float(_cache_validites["jusqua"]):
        return _cache_validites["table"]
    if not api_configuree():
        return {}
    try:
        bruts = lister_etudiants()
    except Exception as exc:
        journal.warning("Durées de programme indisponibles : %s", exc)
        _cache_validites["jusqua"] = maintenant + 60
        _cache_validites["table"] = {}
        return {}
    table: dict[str, date] = {}
    for brut in bruts:
        if not isinstance(brut, dict) or not _compte_inscrit(brut):
            continue
        fin = date_validite_api(brut.get("intake_year"), brut.get("duration_years"))
        numero = _matricule_cle(str(brut.get("student_number") or ""))
        if numero and fin:
            table[numero] = fin
    if not table:
        return {}
    _cache_validites["jusqua"] = maintenant + 600
    _cache_validites["table"] = table
    return table


def validite_connue(matricule: str) -> date | None:
    """Date de fin du programme pour ce matricule, ou rien si l'API ne le connaît pas."""
    try:
        return validites_programmes().get(_matricule_cle(matricule))
    except Exception as exc:
        journal.warning("Validité Université indisponible pour %s : %s", matricule, exc)
        return None


def appliquer_validites(db: Session) -> int:
    """Aligne la validité des cartes déjà dans l'atelier sur la durée du programme.

    N'ajoute ni ne retire personne.
    """
    table = validites_programmes()
    if not table:
        return 0
    changes = 0
    for etudiant in db.scalars(select(Etudiant)).all():
        fin = table.get(_matricule_cle(etudiant.matricule))
        if fin is None:
            continue
        carte = carte_courante(db, etudiant.id)
        carte_a_jour = carte is None or carte.statut == "remplacee" or carte.date_validite == fin
        if etudiant.date_validite == fin and carte_a_jour:
            continue
        etudiant.date_validite = fin
        if carte is not None and carte.statut != "remplacee":
            carte.date_validite = fin
        changes += 1
    if changes:
        db.commit()
    return changes


_STATUTS_INSCRITS = {"", "active", "actif", "enrolled", "inscrit"}


def _compte_inscrit(brut: dict) -> bool:
    """Garde un étudiant inscrit qui a un compte sur la plateforme de l'université."""
    if not isinstance(brut, dict):
        return False
    if not str(brut.get("student_number") or "").strip():
        return False
    statut = str(brut.get("status") or "active").strip().lower()
    if statut not in _STATUTS_INSCRITS:
        return False
    if brut.get("is_alumni") is True:
        return False
    if "user_id" in brut and not brut.get("user_id"):
        return False
    return True


def _enregistrer_fiche_api(db: Session, brut: dict, acteur_id: int | None) -> tuple[str, str, bool]:
    """Enregistre une fiche API. Retourne (matricule, url photo, créée)."""
    raw = fiche_depuis_api(brut)
    if not raw["date_validite"]:
        raise ValueError("année d'entrée ou durée de programme manquante dans l'API.")
    fiche = controler_fiche(
        raw["prenom"],
        raw["nom"],
        raw["matricule"],
        raw["ecole"],
        raw["annee"],
        raw["date_validite"].isoformat(),
        raw["email"] or None,
        None,
    )
    fiche.annee_academique = raw["annee"] or fiche.annee_academique
    fiche.date_validite = raw["date_validite"]
    detail = (
        f"API Université · {raw['programme'] or 'programme'} · "
        f"{raw['duree_ans']} an(s) · valide jusqu'au {fiche.date_validite.isoformat()}"
    )
    existant = db.scalar(select(Etudiant).where(Etudiant.matricule == fiche.matricule))
    if existant is None:
        creer_etudiant(
            db,
            prenom=fiche.prenom,
            nom=fiche.nom,
            matricule=fiche.matricule,
            filiere=fiche.filiere,
            annee_academique=fiche.annee_academique,
            date_validite=fiche.date_validite,
            email=fiche.email,
            programme=raw["programme"],
            sexe="M",
            jpeg=None,
            acteur_id=acteur_id,
            action="importee",
            details=detail,
        )
    else:
        modifier_etudiant(
            db,
            existant,
            prenom=fiche.prenom,
            nom=fiche.nom,
            filiere=fiche.filiere,
            annee_academique=fiche.annee_academique,
            date_validite=fiche.date_validite,
            email=fiche.email,
            programme=raw["programme"],
            sexe=existant.sexe or "M",
            acteur_id=acteur_id,
        )
    return fiche.matricule, raw["photo_url"], existant is None


def synchro_etudiants(
    db: Session,
    *,
    acteur_id: int | None = None,
    matricules_comptes: set[str] | None = None,
) -> dict:
    """Aligne l'atelier sur l'API, limité aux comptes étudiants quand la liste est fournie."""
    if not api_configuree():
        raise RuntimeError(
            "UNIVERSITE_API_KEY est absent du fichier .env des cartes. "
            "Ajoutez la clé API Université pour synchroniser les étudiants."
        )

    crees = maj = retires = 0
    erreurs: list[str] = []
    matricules_api: set[str] = set()
    photos_a_prendre: list[dict[str, str]] = []

    try:
        bruts = lister_etudiants()
    except httpx.HTTPError as exc:
        raise RuntimeError(f"API Université injoignable : {exc}") from exc
    if not bruts:
        raise RuntimeError("L'API Université n'a renvoyé aucun étudiant. La base atelier n'a pas été modifiée.")

    comptes = None
    if matricules_comptes is not None:
        comptes = {_matricule_cle(str(valeur)) for valeur in matricules_comptes if _matricule_cle(str(valeur))}
        if not comptes:
            raise RuntimeError("Aucun compte étudiant transmis par la scolarité. La base atelier n'a pas été modifiée.")

    hors_compte = 0
    non_inscrits = 0
    for brut in bruts:
        numero = str((brut or {}).get("student_number") or "").strip()
        cle = _matricule_cle(numero)
        if not _compte_inscrit(brut):
            non_inscrits += 1
            continue
        if comptes is not None and cle not in comptes:
            hors_compte += 1
            continue
        try:
            matricule, photo, cree = _enregistrer_fiche_api(db, brut, acteur_id)
            matricules_api.add(_matricule_cle(matricule))
            if cree:
                crees += 1
            else:
                maj += 1
            if photo:
                photos_a_prendre.append({"matricule": matricule, "url": photo})
        except Exception as exc:
            if numero:
                matricules_api.add(cle)
            erreurs.append(f"{numero or '?'} : {exc}")
            journal.warning("Synchro Université échouée pour %s : %s", numero or "?", exc)

    if crees + maj == 0:
        if non_inscrits and not erreurs and not hors_compte:
            raise RuntimeError(
                "L'API Université n'a renvoyé aucun étudiant inscrit avec un compte. La base atelier n'a pas été modifiée."
            )
        if comptes is not None and hors_compte and not erreurs:
            raise RuntimeError(
                "Aucun étudiant de l'API Université n'est dans les comptes étudiants. La base atelier n'a pas été modifiée."
            )
        raise RuntimeError(
            "Aucune fiche API n'a pu être enregistrée. La base atelier n'a pas été modifiée."
            + (f" {erreurs[0]}" if erreurs else "")
        )

    locaux = list(db.scalars(select(Etudiant)).all())
    for local in locaux:
        if _matricule_cle(local.matricule) in matricules_api:
            continue
        try:
            supprimer_etudiant(db, local)
            retires += 1
        except Exception as exc:
            erreurs.append(f"{local.matricule} : retrait impossible ({exc})")

    return {
        "ok": True,
        "recus": len(bruts),
        "crees": crees,
        "maj": maj,
        "photos": 0,
        "retires": retires,
        "erreurs": erreurs[:40],
        "photos_a_prendre": photos_a_prendre,
        "message": (
            (
                f"{len(matricules_api)} étudiant(s) affiché(s), présents dans l'API Université et dans les comptes étudiants"
                if comptes is not None
                else f"{len(matricules_api)} étudiant(s) inscrits à l'université affiché(s), et aucun autre"
            )
            + (f", {retires} retiré(s) de l'atelier" if retires else "")
            + "."
            + (f" {len(erreurs)} fiche(s) refusée(s) : {erreurs[0]}" if erreurs else "")
            + " Validité = année d'entrée + durée du programme."
        ),
    }


def completer_photos(paires: list[dict[str, str]], acteur_id: int | None = None) -> None:
    """Pose les photos API après la réponse, sans réintroduire d'anciennes fiches."""
    if not paires:
        return
    from app.database import SessionLocal

    with SessionLocal() as db:
        with httpx.Client(timeout=20.0, headers=_entetes(), follow_redirects=True) as http:
            for paire in paires:
                matricule = paire.get("matricule") or ""
                url = paire.get("url") or ""
                if not matricule or not url:
                    continue
                try:
                    jpeg = telecharger_photo(url, http)
                    if not jpeg:
                        continue
                    etudiant = db.scalar(select(Etudiant).where(Etudiant.matricule == matricule))
                    if etudiant is not None:
                        remplacer_photo(db, etudiant, jpeg, acteur_id)
                except Exception as exc:
                    journal.warning("Photo Université non posée pour %s : %s", matricule, exc)
