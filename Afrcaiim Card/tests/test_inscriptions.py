"""Le site de l'université peut créer une fiche, puis la retirer."""

from fastapi.testclient import TestClient
from sqlalchemy import select

from app.database import SessionLocal
from app.main import app
from app.models import Etudiant, Utilisateur

_JETON = "jeton-de-test-assez-long"
_MATRICULE = "AIIM-TEST-RETIRE"


def _absent() -> bool:
    with SessionLocal() as db:
        etudiant = db.scalar(select(Etudiant).where(Etudiant.matricule == _MATRICULE))
        if etudiant is None:
            return True
        compte = db.scalar(select(Utilisateur).where(Utilisateur.etudiant_id == etudiant.id))
        return compte is None and False


def test_le_site_retire_aussi_la_fiche(monkeypatch):
    monkeypatch.setenv("INSCRIPTION_JETON", _JETON)
    client = TestClient(app)
    entete = {"X-Jeton": _JETON}
    fiche = {
        "prenom": "Test",
        "nom": "Retrait",
        "matricule": _MATRICULE,
        "ecole": "AFRICAIIM Tech",
        "sexe": "M",
    }
    try:
        cree = client.post("/api/inscriptions", headers=entete, json=fiche)
        assert cree.status_code == 200, cree.text
        refuse = client.delete(f"/api/inscriptions/{_MATRICULE}", headers={"X-Jeton": "un-autre-jeton-secret"})
        assert refuse.status_code == 401
        assert _absent() is False
        parti = client.post("/api/inscriptions", headers=entete, json={"matricule": _MATRICULE, "supprime": True})
        assert parti.status_code == 200
        assert parti.json() == {"matricule": _MATRICULE, "supprime": True}
        assert _absent() is True
        encore = client.delete(f"/api/inscriptions/{_MATRICULE}", headers=entete)
        assert encore.json()["supprime"] is False
    finally:
        client.delete(f"/api/inscriptions/{_MATRICULE}", headers=entete)


def test_matricule_change_garde_la_meme_fiche_et_l_adresse_etudiante(monkeypatch):
    monkeypatch.setenv("INSCRIPTION_JETON", _JETON)
    client = TestClient(app)
    entete = {"X-Jeton": _JETON}
    ancien, nouveau = "AIIM-TEST-ANCIEN", "AIIM-TEST-NOUVEAU"
    fiche = {"prenom": "Mamadou Alpha", "nom": "Renomme", "ecole": "AFRICAIIM Tech"}
    try:
        assert client.post("/api/inscriptions", headers=entete, json={**fiche, "matricule": ancien}).status_code == 200
        with SessionLocal() as db:
            avant = db.scalar(select(Etudiant).where(Etudiant.matricule == ancien))
            assert avant.email == "alpha.renomme@univ-africaiim.com"
            identifiant = avant.id
        renomme = client.post("/api/inscriptions", headers=entete, json={**fiche, "matricule": nouveau, "ancien_matricule": ancien})
        assert renomme.status_code == 200, renomme.text
        with SessionLocal() as db:
            assert db.scalar(select(Etudiant).where(Etudiant.matricule == ancien)) is None
            assert db.scalar(select(Etudiant).where(Etudiant.matricule == nouveau)).id == identifiant
    finally:
        client.delete(f"/api/inscriptions/{ancien}", headers=entete)
        client.delete(f"/api/inscriptions/{nouveau}", headers=entete)
