"""Synchronisation des étudiants depuis l'API Université AFRICAIIM."""

from __future__ import annotations

import logging
from typing import Any
from urllib.parse import urljoin

import httpx
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import env
from app.models import Etudiant
from app.services.import_etudiants import controler_fiche, validite_par_defaut
from app.services.metier import creer_etudiant, modifier_etudiant, remplacer_photo
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


def _annee_depuis_intake(valeur: Any) -> str | None:
    try:
        annee = int(valeur)
    except (TypeError, ValueError):
        return None
    if annee < 2000 or annee > 2100:
        return None
    return f"{annee}-{annee + 1}"


def fiche_depuis_api(brut: dict) -> dict:
    """Transforme une fiche API en champs utilisables par controler_fiche / upsert."""
    matricule = str(brut.get("student_number") or "").strip()
    prenom = str(brut.get("first_name") or "").strip()
    nom = str(brut.get("last_name") or "").strip()
    ecole = str(brut.get("school") or "").strip()
    email = str(brut.get("institutional_email") or brut.get("email") or "").strip()
    annee = _annee_depuis_intake(brut.get("intake_year")) or ""
    photo_url = str(brut.get("photo_url") or "").strip()
    return {
        "matricule": matricule,
        "prenom": prenom,
        "nom": nom,
        "ecole": ecole,
        "email": email,
        "annee": annee,
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
            params = None  # l'URL next contient déjà les paramètres
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


def synchro_etudiants(db: Session, *, acteur_id: int | None = None) -> dict:
    """Crée ou met à jour les fiches cartes à partir de l'API Université (sans suppression)."""
    if not api_configuree():
        raise RuntimeError(
            "UNIVERSITE_API_KEY est absent du fichier .env des cartes. "
            "Ajoutez la clé API Université pour synchroniser les étudiants."
        )

    crees = maj = photos = 0
    erreurs: list[str] = []

    with httpx.Client(timeout=TIMEOUT, headers=_entetes(), follow_redirects=True) as http:
        try:
            bruts = lister_etudiants(http)
        except httpx.HTTPError as exc:
            raise RuntimeError(f"API Université injoignable : {exc}") from exc

        for brut in bruts:
            try:
                raw = fiche_depuis_api(brut)
                fiche = controler_fiche(
                    raw["prenom"],
                    raw["nom"],
                    raw["matricule"],
                    raw["ecole"],
                    raw["annee"],
                    None,
                    raw["email"] or None,
                    None,
                )
                if raw["annee"]:
                    fiche.annee_academique = raw["annee"]
                    fiche.date_validite = validite_par_defaut(raw["annee"])

                existant = db.scalar(select(Etudiant).where(Etudiant.matricule == fiche.matricule))
                jpeg = telecharger_photo(raw["photo_url"], http) if raw["photo_url"] else None

                if existant is None:
                    etudiant, _secret, _compte = creer_etudiant(
                        db,
                        prenom=fiche.prenom,
                        nom=fiche.nom,
                        matricule=fiche.matricule,
                        filiere=fiche.filiere,
                        annee_academique=fiche.annee_academique,
                        date_validite=fiche.date_validite,
                        email=fiche.email,
                        sexe="M",
                        jpeg=jpeg,
                        acteur_id=acteur_id,
                        action="importee",
                        details="Synchronisé depuis l'API Université",
                    )
                    crees += 1
                    if jpeg:
                        photos += 1
                    elif jpeg is None and raw["photo_url"]:
                        erreurs.append(f"{fiche.matricule} : photo non récupérée")
                else:
                    modifier_etudiant(
                        db,
                        existant,
                        prenom=fiche.prenom,
                        nom=fiche.nom,
                        filiere=fiche.filiere,
                        annee_academique=fiche.annee_academique,
                        date_validite=fiche.date_validite,
                        email=fiche.email or existant.email,
                        sexe=existant.sexe or "M",
                        acteur_id=acteur_id,
                    )
                    maj += 1
                    if jpeg:
                        remplacer_photo(db, existant, jpeg, acteur_id)
                        photos += 1
            except Exception as exc:
                matricule = str((brut or {}).get("student_number") or "?")
                erreurs.append(f"{matricule} : {exc}")
                journal.warning("Synchro Université échouée pour %s : %s", matricule, exc)
                try:
                    db.rollback()
                except Exception:
                    pass

    return {
        "ok": True,
        "recus": len(bruts),
        "crees": crees,
        "maj": maj,
        "photos": photos,
        "erreurs": erreurs[:40],
        "message": (
            f"{len(bruts)} fiche(s) reçue(s) : {crees} créée(s), {maj} mise(s) à jour"
            + (f", {photos} photo(s)" if photos else "")
            + (f", {len(erreurs)} erreur(s)" if erreurs else "")
            + "."
        ),
    }
