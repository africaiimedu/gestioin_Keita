"""Compte étudiant : adresse reçue de la scolarité, mot de passe de départ, changement obligatoire."""

from fastapi.testclient import TestClient
from sqlalchemy import select

from app.database import SessionLocal
from app.main import app
from app.models import Etudiant, Utilisateur
from app.security import hash_mot_de_passe, verifier_mot_de_passe
from app.services.comptes import adresse_compte, mot_de_passe_depart

_JETON = "jeton-de-test-assez-long"
_MATRICULE = "AIIM-TEST-COMPTE"
_ADRESSE = "alpha.testcompte@univ-africaiim.com"


def _csrf(texte: str) -> str:
    return texte.split('name="csrf" value="', 1)[1].split('"', 1)[0]


def _compte() -> Utilisateur | None:
    with SessionLocal() as db:
        etudiant = db.scalar(select(Etudiant).where(Etudiant.matricule == _MATRICULE))
        if etudiant is None:
            return None
        return db.scalar(select(Utilisateur).where(Utilisateur.etudiant_id == etudiant.id))


def test_adresse_par_defaut():
    with SessionLocal() as db:
        assert adresse_compte(db, "Mamadou Alpha", "Testcompte") == _ADRESSE
        assert adresse_compte(db, "La Grâce", "Leno-Test") == "grace.leno-test@univ-africaiim.com"


def test_compte_cree_aligne_et_mot_de_passe_obligatoire(monkeypatch):
    monkeypatch.setenv("INSCRIPTION_JETON", _JETON)
    client = TestClient(app)
    entete = {"X-Jeton": _JETON}
    fiche = {"prenom": "Mamadou Alpha", "nom": "Testcompte", "matricule": _MATRICULE, "ecole": "AFRICAIIM Tech"}
    try:
        cree = client.post("/api/inscriptions", headers=entete, json={**fiche, "compte": _ADRESSE})
        assert cree.status_code == 200, cree.text
        compte = _compte()
        assert compte.identifiant == _ADRESSE
        assert compte.doit_changer_mot_de_passe is True
        assert verifier_mot_de_passe(mot_de_passe_depart(), compte.mot_de_passe_hash)

        refuse = client.post("/api/inscriptions", headers=entete, json={**fiche, "compte": "alpha@gmail.com"})
        assert refuse.status_code == 400

        page = client.get("/login")
        entre = client.post(
            "/login",
            data={"identifiant": _ADRESSE, "mot_de_passe": mot_de_passe_depart(), "csrf": _csrf(page.text)},
            follow_redirects=False,
        )
        assert entre.headers["location"] == "/compte"
        assert client.get("/espace", follow_redirects=False).headers["location"] == "/compte"
        formulaire = client.get("/compte")
        assert "Choisissez votre mot de passe" in formulaire.text
        meme = client.post(
            "/compte",
            data={"actuel": mot_de_passe_depart(), "nouveau": mot_de_passe_depart(), "confirmation": mot_de_passe_depart(), "csrf": _csrf(formulaire.text)},
            follow_redirects=False,
        )
        assert meme.headers["location"] == "/compte"
        nouveau = "Mon-propre-secret-2026"
        change = client.post(
            "/compte",
            data={"actuel": mot_de_passe_depart(), "nouveau": nouveau, "confirmation": nouveau, "csrf": _csrf(client.get("/compte").text)},
            follow_redirects=False,
        )
        assert change.headers["location"] == "/espace"
        assert client.get("/espace", follow_redirects=False).status_code == 200

        autre = "alpha.testcompte2@univ-africaiim.com"
        aligne = client.post("/api/inscriptions", headers=entete, json={**fiche, "compte": autre})
        assert aligne.status_code == 200, aligne.text
        compte = _compte()
        assert compte.identifiant == autre
        assert verifier_mot_de_passe(nouveau, compte.mot_de_passe_hash)
    finally:
        client.delete(f"/api/inscriptions/{_MATRICULE}", headers=entete)


def test_compte_jamais_utilise_repart_du_mot_de_passe_de_depart(monkeypatch):
    monkeypatch.setenv("INSCRIPTION_JETON", _JETON)
    client = TestClient(app)
    entete = {"X-Jeton": _JETON}
    fiche = {"prenom": "Mamadou Alpha", "nom": "Testcompte", "matricule": _MATRICULE, "ecole": "AFRICAIIM Tech"}
    try:
        assert client.post("/api/inscriptions", headers=entete, json=fiche).status_code == 200
        with SessionLocal() as db:
            etudiant = db.scalar(select(Etudiant).where(Etudiant.matricule == _MATRICULE))
            compte = db.scalar(select(Utilisateur).where(Utilisateur.etudiant_id == etudiant.id))
            compte.identifiant = _MATRICULE
            compte.mot_de_passe_hash = hash_mot_de_passe("Ancien-provisoire-99")
            db.commit()
        assert client.post("/api/inscriptions", headers=entete, json={**fiche, "compte": _ADRESSE}).status_code == 200
        compte = _compte()
        assert compte.identifiant == _ADRESSE
        assert verifier_mot_de_passe(mot_de_passe_depart(), compte.mot_de_passe_hash)
    finally:
        client.delete(f"/api/inscriptions/{_MATRICULE}", headers=entete)
