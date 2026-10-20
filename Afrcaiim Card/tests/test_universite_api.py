"""Synchro atelier depuis l'API Université (sans appel réseau)."""

from __future__ import annotations

from sqlalchemy import select

from app.database import SessionLocal
from app.models import Etudiant
from app.services import universite_api
from app.services.metier import supprimer_etudiant
from app.services.universite_api import fiche_depuis_api, synchro_etudiants

_MATRICULE = "UA26TESTSYNC1"


def test_fiche_depuis_api_mapping():
    brut = {
        "student_number": "UA26ABS0001",
        "first_name": "Aïcha deen",
        "last_name": "Camara",
        "school": "AFRICAIIM Business School",
        "email": "perso@exemple.com",
        "institutional_email": "aichadeen.camara@etu.univ-africaiim.com",
        "intake_year": 2026,
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
    assert fiche["photo_url"].startswith("https://")


def test_synchro_upsert_sans_reseau(monkeypatch):
    monkeypatch.setenv("UNIVERSITE_API_KEY", "cle-de-test-assez-longue")
    monkeypatch.setenv("UNIVERSITE_API_URL", "https://api.exemple.test")

    def faux_lister(client=None):
        return [
            {
                "student_number": _MATRICULE,
                "first_name": "Sync",
                "last_name": "Testeur",
                "school": "AFRICAIIM Tech",
                "institutional_email": "sync.testeur@etu.univ-africaiim.com",
                "intake_year": 2026,
                "photo_url": "",
                "status": "active",
            }
        ]

    monkeypatch.setattr(universite_api, "lister_etudiants", faux_lister)
    monkeypatch.setattr(universite_api, "telecharger_photo", lambda url, client=None: None)

    with SessionLocal() as db:
        existant = db.scalar(select(Etudiant).where(Etudiant.matricule == _MATRICULE))
        if existant:
            supprimer_etudiant(db, existant)

    try:
        with SessionLocal() as db:
            premier = synchro_etudiants(db)
            assert premier["crees"] == 1
            assert premier["maj"] == 0
            etu = db.scalar(select(Etudiant).where(Etudiant.matricule == _MATRICULE))
            assert etu is not None
            assert etu.prenom == "Sync"
            assert etu.filiere == "AFRICAIIM Tech"

        with SessionLocal() as db:
            second = synchro_etudiants(db)
            assert second["crees"] == 0
            assert second["maj"] == 1
            etu = db.scalar(select(Etudiant).where(Etudiant.matricule == _MATRICULE))
            assert etu.nom == "Testeur"
    finally:
        with SessionLocal() as db:
            existant = db.scalar(select(Etudiant).where(Etudiant.matricule == _MATRICULE))
            if existant:
                supprimer_etudiant(db, existant)
