"""Synchro atelier depuis l'API Université (sans appel réseau)."""

from __future__ import annotations

from datetime import date

from sqlalchemy import select

from app.database import SessionLocal
from app.models import Etudiant
from app.services import universite_api
from app.services.metier import creer_etudiant, supprimer_etudiant
from app.services.universite_api import date_validite_api, fiche_depuis_api, synchro_etudiants

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
    assert fiche["date_validite"] == date(2029, 8, 31)
    assert date_validite_api(2026, 1) == date(2027, 8, 31)


def test_synchro_upsert_et_retrait_hors_api(monkeypatch):
    monkeypatch.setenv("UNIVERSITE_API_KEY", "cle-de-test-assez-longue")
    monkeypatch.setenv("UNIVERSITE_API_URL", "https://api.exemple.test")

    def faux_lister(client=None):
        return [
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
            }
        ]

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

        with SessionLocal() as db:
            second = synchro_etudiants(db)
            assert second["crees"] == 0
            assert second["maj"] == 1
            assert second["retires"] == 0
    finally:
        with SessionLocal() as db:
            for mat in (_MATRICULE, _HORS_API):
                existant = db.scalar(select(Etudiant).where(Etudiant.matricule == mat))
                if existant:
                    supprimer_etudiant(db, existant)
