"""Synchronisation des étudiants depuis l'API Université AFRICAIIM.

La base atelier reflète exclusivement la liste Université : upsert + retrait
des fiches locales absentes de l'API. La validité suit la durée du programme.
"""

from __future__ import annotations

import logging
import re
from datetime import date
from typing import Any
from urllib.parse import urljoin

import httpx
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import env
from app.models import Etudiant
from app.services.import_etudiants import controler_fiche
from app.services.metier import creer_etudiant, modifier_etudiant, remplacer_photo, supprimer_etudiant
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


def synchro_etudiants(db: Session, *, acteur_id: int | None = None) -> dict:
    """Aligne la base atelier sur l'API Université (création, maj, retrait hors API)."""
    if not api_configuree():
        raise RuntimeError(
            "UNIVERSITE_API_KEY est absent du fichier .env des cartes. "
            "Ajoutez la clé API Université pour synchroniser les étudiants."
        )

    crees = maj = photos = retires = 0
    erreurs: list[str] = []
    matricules_api: set[str] = set()

    with httpx.Client(timeout=TIMEOUT, headers=_entetes(), follow_redirects=True) as http:
        try:
            bruts = lister_etudiants(http)
        except httpx.HTTPError as exc:
            raise RuntimeError(f"API Université injoignable : {exc}") from exc

        for brut in bruts:
            try:
                raw = fiche_depuis_api(brut)
                if not raw["date_validite"]:
                    raise ValueError("année d'entrée ou durée de programme manquante dans l'API.")
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
                # 100 % API : année d'entrée + validité selon durée du programme.
                fiche.annee_academique = raw["annee"] or fiche.annee_academique
                fiche.date_validite = raw["date_validite"]
                matricules_api.add(fiche.matricule)

                existant = db.scalar(select(Etudiant).where(Etudiant.matricule == fiche.matricule))
                jpeg = telecharger_photo(raw["photo_url"], http) if raw["photo_url"] else None
                detail = (
                    f"API Université · {raw['programme'] or 'programme'} · "
                    f"{raw['duree_ans']} an(s) · valide jusqu'au {fiche.date_validite.isoformat()}"
                )

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
                        programme=raw["programme"],
                        sexe="M",
                        jpeg=jpeg,
                        acteur_id=acteur_id,
                        action="importee",
                        details=detail,
                    )
                    crees += 1
                    if jpeg:
                        photos += 1
                    elif raw["photo_url"]:
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
                        email=fiche.email,
                        programme=raw["programme"],
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

        # N'afficher / garder que les étudiants présents dans l'API Université.
        locaux = list(db.scalars(select(Etudiant)).all())
        for local in locaux:
            if local.matricule in matricules_api:
                continue
            try:
                supprimer_etudiant(db, local)
                retires += 1
            except Exception as exc:
                erreurs.append(f"{local.matricule} : retrait impossible ({exc})")
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
        "retires": retires,
        "erreurs": erreurs[:40],
        "message": (
            f"{len(bruts)} étudiant(s) Université : {crees} créé(s), {maj} mis à jour"
            + (f", {photos} photo(s)" if photos else "")
            + (f", {retires} retiré(s) hors API" if retires else "")
            + (f", {len(erreurs)} erreur(s) ({erreurs[0]})" if erreurs else "")
            + ". Validité = année d'entrée + durée du programme."
        ),
    }
