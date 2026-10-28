"""Synchro atelier depuis l'API Université (sans appel réseau)."""

from __future__ import annotations

from datetime import date

from sqlalchemy import select

from app.database import SessionLocal
from app.models import Etudiant
from app.services import universite_api
from app.services.metier import carte_courante, creer_etudiant, supprimer_etudiant
from app.services.universite_api import (
    appliquer_fiches,
    appliquer_validites,
    date_validite_api,
    fiche_depuis_api,
    synchro_etudiants,
    vider_cache_validites,
)

_MATRICULE = "UA26TESTSYNC1"
_HORS_API = "UA26TESTLOCAL9"


def test_fiche_depuis_api_mapping_et_duree():
    brut = {
        "student_number": "UA26ABS0001",
        "first_name": "Aïcha deen",
        "last_name": "Camara",
        "school": "AFRICAIIM Business School",
        "programme": "Bachelor en Management International",
        "email": "perso@exemple.com",
        "institutional_email": "aichadeen.camara@etu.univ-africaiim.com",
        "intake_year": 2026,
        "duration_years": 3,
        "photo_url": "https://api.exemple.test/photo.jpg",
        "status": "active",
    }
    fiche = fiche_depuis_api(brut)
    assert fiche["matricule"] == "UA26ABS0001"
    assert fiche["prenom"] == "Aïcha deen"
    assert fiche["nom"] == "Camara"
    assert fiche["ecole"] == "AFRICAIIM Business School"
    assert fiche["email"] == "aichadeen.camara@etu.univ-africaiim.com"
    assert fiche["annee"] == "2026-2027"
    assert fiche["duree_ans"] == 3
    assert fiche["niveau"] == "1re année"
    assert fiche["date_validite"] == date(2029, 8, 31)
    assert date_validite_api(2026, 1) == date(2027, 8, 31)


def test_fiche_nom_vide_reparti_depuis_prenom():
    """Cas réel API : last_name vide, first_name = « Mamadou Adama »."""
    fiche = fiche_depuis_api(
        {
            "student_number": "UA26AT0006",
            "first_name": "Mamadou Adama",
            "last_name": "",
            "school": "AFRICAIIM Tech",
            "intake_year": 2026,
            "duration_years": 5,
            "institutional_email": "mamadouadama.africaiim@etu.univ-africaiim.com",
        }
    )
    assert fiche["prenom"] == "Mamadou"
    assert fiche["nom"] == "Adama"
    assert fiche["date_validite"] == date(2031, 8, 31)


def test_synchro_upsert_et_retrait_hors_api(monkeypatch):
    monkeypatch.setenv("UNIVERSITE_API_KEY", "cle-de-test-assez-longue")
    monkeypatch.setenv("UNIVERSITE_API_URL", "https://api.exemple.test")

    fiches_api = [
        {
            "student_number": _MATRICULE,
            "first_name": "Sync",
            "last_name": "Testeur",
            "school": "AFRICAIIM Tech",
            "programme": "Licence",
            "institutional_email": "sync.testeur@etu.univ-africaiim.com",
            "intake_year": 2026,
            "duration_years": 3,
            "photo_url": "",
            "status": "active",
            "user_id": 1,
        },
        {
            "student_number": "UA26INACTIF1",
            "first_name": "Inactif",
            "last_name": "Testeur",
            "school": "AFRICAIIM Tech",
            "programme": "Licence",
            "institutional_email": "inactif.testeur@etu.univ-africaiim.com",
            "intake_year": 2026,
            "duration_years": 3,
            "photo_url": "",
            "status": "inactive",
            "user_id": 2,
        },
    ]

    def faux_lister(client=None):
        return fiches_api

    monkeypatch.setattr(universite_api, "lister_etudiants", faux_lister)
    monkeypatch.setattr(universite_api, "telecharger_photo", lambda url, client=None: None)

    with SessionLocal() as db:
        for mat in (_MATRICULE, _HORS_API):
            existant = db.scalar(select(Etudiant).where(Etudiant.matricule == mat))
            if existant:
                supprimer_etudiant(db, existant)
        creer_etudiant(
            db,
            prenom="Local",
            nom="HorsApi",
            matricule=_HORS_API,
            filiere="AFRICAIIM Tech",
            annee_academique="2026-2027",
            date_validite=date(2027, 8, 31),
            email="local.horsapi@univ-africaiim.com",
            sexe="M",
            action="creee",
            details="Fiche locale hors API",
        )

    try:
        with SessionLocal() as db:
            premier = synchro_etudiants(db)
            assert premier["crees"] == 1
            assert premier["retires"] == 1
            etu = db.scalar(select(Etudiant).where(Etudiant.matricule == _MATRICULE))
            assert etu is not None
            assert etu.date_validite == date(2029, 8, 31)
            assert db.scalar(select(Etudiant).where(Etudiant.matricule == _HORS_API)) is None
            assert db.scalar(select(Etudiant).where(Etudiant.matricule == "UA26INACTIF1")) is None

        with SessionLocal() as db:
            second = synchro_etudiants(db)
            assert second["crees"] == 0
            assert second["maj"] == 1
            assert second["retires"] == 0

        fiches_api.append({
            "student_number": "UA26HORSCOMPTE",
            "first_name": "Hors",
            "last_name": "Compte",
            "school": "AFRICAIIM Tech",
            "programme": "Licence",
            "institutional_email": "hors.compte@etu.univ-africaiim.com",
            "intake_year": 2026,
            "duration_years": 3,
            "photo_url": "",
            "status": "active",
        })
        with SessionLocal() as db:
            creer_etudiant(
                db,
                prenom="Hors",
                nom="Compte",
                matricule="UA26HORSCOMPTE",
                filiere="AFRICAIIM Tech",
                annee_academique="2026-2027",
                date_validite=date(2027, 8, 31),
                email="hors.compte@univ-africaiim.com",
                sexe="M",
                action="creee",
                details="Présent dans l'API mais pas dans les comptes",
            )
            borne = synchro_etudiants(db, matricules_comptes={_MATRICULE})
            assert borne["maj"] == 1
            assert borne["crees"] == 0
            assert db.scalar(select(Etudiant).where(Etudiant.matricule == _MATRICULE)) is not None
            assert db.scalar(select(Etudiant).where(Etudiant.matricule == "UA26HORSCOMPTE")) is None
    finally:
        with SessionLocal() as db:
            for mat in (_MATRICULE, _HORS_API, "UA26HORSCOMPTE", "UA26INACTIF1"):
                existant = db.scalar(select(Etudiant).where(Etudiant.matricule == mat))
                if existant:
                    supprimer_etudiant(db, existant)


def test_appliquer_validites_aligne_la_carte_sans_retirer(monkeypatch):
    monkeypatch.setenv("UNIVERSITE_API_KEY", "cle-de-test-assez-longue")
    monkeypatch.setenv("UNIVERSITE_API_URL", "https://api.exemple.test")
    vider_cache_validites()
    monkeypatch.setattr(
        universite_api,
        "lister_etudiants",
        lambda client=None: [
            {
                "student_number": _MATRICULE,
                "first_name": "Sync",
                "last_name": "Testeur",
                "status": "active",
                "user_id": 1,
                "intake_year": 2026,
                "duration_years": 3,
            }
        ],
    )
    with SessionLocal() as db:
        existant = db.scalar(select(Etudiant).where(Etudiant.matricule == _MATRICULE))
        if existant:
            supprimer_etudiant(db, existant)
        creer_etudiant(
            db,
            prenom="Sync",
            nom="Testeur",
            matricule=_MATRICULE,
            filiere="AFRICAIIM Tech",
            annee_academique="2026-2027",
            date_validite=date(2027, 8, 31),
            email="sync.testeur@etu.univ-africaiim.com",
            sexe="M",
            action="creee",
            details="Validité encore annuelle",
        )
    try:
        with SessionLocal() as db:
            assert appliquer_validites(db) == 1
            etu = db.scalar(select(Etudiant).where(Etudiant.matricule == _MATRICULE))
            assert etu is not None
            assert etu.date_validite == date(2029, 8, 31)
            carte = carte_courante(db, etu.id)
            assert carte is not None
            assert carte.date_validite == date(2029, 8, 31)
            assert appliquer_validites(db) == 0
    finally:
        vider_cache_validites()
        with SessionLocal() as db:
            existant = db.scalar(select(Etudiant).where(Etudiant.matricule == _MATRICULE))
            if existant:
                supprimer_etudiant(db, existant)


def test_appliquer_fiches_met_a_jour_sans_retirer(monkeypatch):
    monkeypatch.setenv("UNIVERSITE_API_KEY", "cle-de-test-assez-longue")
    monkeypatch.setenv("UNIVERSITE_API_URL", "https://api.exemple.test")
    vider_cache_validites()
    monkeypatch.setattr(
        universite_api,
        "lister_etudiants",
        lambda client=None: [
            {
                "student_number": _MATRICULE,
                "first_name": "Kerfala",
                "last_name": "Yattara",
                "school": "AFRICAIIM Tech",
                "programme": "Cycle Préparatoire Intégré (CPI)",
                "institutional_email": "kerfala.yattara@etu.univ-africaiim.com",
                "status": "active",
                "user_id": 1,
                "intake_year": 2026,
                "duration_years": 2,
            }
        ],
    )
    with SessionLocal() as db:
        for mat in (_MATRICULE, _HORS_API):
            existant = db.scalar(select(Etudiant).where(Etudiant.matricule == mat))
            if existant:
                supprimer_etudiant(db, existant)
        creer_etudiant(
            db,
            prenom="Ancien",
            nom="Nom",
            matricule=_MATRICULE,
            filiere="AFRICAIIM Tech",
            annee_academique="2025-2026",
            date_validite=date(2027, 8, 31),
            email="ancien@univ-africaiim.com",
            programme="Ancien programme",
            sexe="M",
            action="creee",
            details="Fiche périmée",
        )
        creer_etudiant(
            db,
            prenom="Local",
            nom="HorsApi",
            matricule=_HORS_API,
            filiere="AFRICAIIM Tech",
            annee_academique="2026-2027",
            date_validite=date(2027, 8, 31),
            email="local.horsapi@univ-africaiim.com",
            sexe="M",
            action="creee",
            details="Hors API, à conserver en synchro douce",
        )
    try:
        with SessionLocal() as db:
            bilan = appliquer_fiches(db, forcer=True)
            assert bilan["ok"] is True
            assert bilan["maj"] == 1
            etu = db.scalar(select(Etudiant).where(Etudiant.matricule == _MATRICULE))
            assert etu.prenom == "Kerfala"
            assert etu.nom == "Yattara"
            assert etu.programme == "Cycle Préparatoire Intégré (CPI)"
            assert etu.date_validite == date(2028, 8, 31)
            assert db.scalar(select(Etudiant).where(Etudiant.matricule == _HORS_API)) is not None
    finally:
        vider_cache_validites()
        with SessionLocal() as db:
            for mat in (_MATRICULE, _HORS_API):
                existant = db.scalar(select(Etudiant).where(Etudiant.matricule == mat))
                if existant:
                    supprimer_etudiant(db, existant)
