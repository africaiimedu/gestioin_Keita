"""Relais d'impression : jeton, annonce des imprimantes, file de travaux, résultat."""

import base64
import io
from datetime import date
from types import SimpleNamespace

from fastapi.testclient import TestClient
from PIL import Image
from sqlalchemy import delete, select

from app.database import Base, SessionLocal, engine
from app.main import app
from app.models import Carte, Etudiant, Journal, PosteImpression, TravailImpression, maintenant
from app.routes import admin_routes, relais_routes
from app.seed import _colonnes_cantine
from app.services import relais

_MATRICULE = "AIIM-RELAIS-TEST"
_POSTE = "Poste relais test"
_JETON = "jeton-relais-de-test-" + "x" * 24


def _nettoyer() -> None:
    Base.metadata.create_all(bind=engine)
    _colonnes_cantine()
    with SessionLocal() as db:
        postes = db.scalars(select(PosteImpression.id).where(PosteImpression.nom == _POSTE)).all()
        if postes:
            db.execute(delete(TravailImpression).where(TravailImpression.poste_id.in_(postes)))
            db.execute(delete(PosteImpression).where(PosteImpression.id.in_(postes)))
        etudiant = db.scalar(select(Etudiant).where(Etudiant.matricule == _MATRICULE))
        if etudiant is not None:
            db.execute(delete(TravailImpression).where(TravailImpression.etudiant_id == etudiant.id))
            db.execute(delete(Journal).where(Journal.etudiant_id == etudiant.id))
            db.execute(delete(Carte).where(Carte.etudiant_id == etudiant.id))
            db.execute(delete(Etudiant).where(Etudiant.id == etudiant.id))
        db.commit()


def _photo() -> bytes:
    tampon = io.BytesIO()
    Image.new("RGB", (480, 600), (90, 120, 160)).save(tampon, "JPEG")
    return tampon.getvalue()


def _appel(client: TestClient, chemin: str, corps: dict | None = None, jeton: str = _JETON):
    return client.post(f"/api/relais{chemin}", json=corps or {}, headers={"Authorization": f"Bearer {jeton}"})


def test_relais_annonce_file_et_resultat(monkeypatch):
    _nettoyer()
    monkeypatch.setattr(relais_routes, "lire_photo", lambda chemin: _photo())
    try:
        with SessionLocal() as db:
            poste, secret = relais.creer_poste(db, _POSTE, _JETON)
            assert secret == _JETON and poste.jeton_hash != _JETON
            poste_id = poste.id
            etudiant = Etudiant(
                prenom="Mariama",
                nom="Testrelais",
                matricule=_MATRICULE,
                filiere="AFRICAIIM Business School",
                annee_academique="2026-2027",
                date_validite=date(2027, 8, 31),
                email="",
                photo_chemin="data/photos/absente.jpg",
                cree_le=maintenant(),
            )
            db.add(etudiant)
            db.flush()
            carte = Carte(
                etudiant_id=etudiant.id,
                jeton="jeton-carte-relais-test",
                statut="active",
                date_emission=date(2026, 9, 1),
                date_validite=date(2027, 8, 31),
                numero_edition=1,
                cree_le=maintenant(),
            )
            db.add(carte)
            db.commit()
            etudiant_id, carte_id = etudiant.id, carte.id

        with TestClient(app) as client:
            assert _appel(client, "/annonce", {"imprimantes": []}, "mauvais-jeton-" + "y" * 30).status_code == 401
            assert client.post("/api/relais/travail").status_code == 401

            annonce = _appel(
                client,
                "/annonce",
                {"imprimantes": [
                    {"nom": "EVOLIS_Primacy_2", "etat": "prête", "primacy": True},
                    {"nom": "Bureau_Laser", "etat": "prête", "primacy": False},
                    {"nom": "mauvais\nnom"},
                    "pas un objet",
                ]},
            )
            assert annonce.status_code == 200 and annonce.json()["imprimantes"] == 2

            with SessionLocal() as db:
                vues = [imp for imp in admin_routes._lister_imprimantes(db) if imp.get("poste_id") == poste_id]
                assert {imp["cle"] for imp in vues} == {
                    f"poste:{poste_id}:EVOLIS_Primacy_2",
                    f"poste:{poste_id}:Bureau_Laser",
                }
                assert all(imp["lieu"] == _POSTE for imp in vues)
                assert _appel(client, "/travail").status_code == 204

                etudiant = db.get(Etudiant, etudiant_id)
                carte = db.get(Carte, carte_id)
                bureau = SimpleNamespace(id=None)
                ok, message = admin_routes._imprimer(
                    db, bureau, etudiant, carte, f"poste:{poste_id}:EVOLIS_Primacy_2", 2, True, "paysage"
                )
                assert ok and _POSTE in message
                refuse, _ = admin_routes._imprimer(
                    db, bureau, etudiant, carte, f"poste:{poste_id}:Inconnue", 1, True, "paysage"
                )
                assert not refuse

            travail = _appel(client, "/travail")
            assert travail.status_code == 200
            donnees = travail.json()
            assert (donnees["imprimante"], donnees["copies"], donnees["recto_verso"]) == ("EVOLIS_Primacy_2", 2, True)
            assert base64.b64decode(donnees["pdf"]).startswith(b"%PDF")
            assert _appel(client, "/travail").status_code == 204

            fini = _appel(client, f"/travail/{donnees['id']}", {"ok": True})
            assert fini.status_code == 200
            assert _appel(client, f"/travail/{donnees['id']}", {"ok": True}).status_code == 404

            with SessionLocal() as db:
                assert db.get(TravailImpression, donnees["id"]).statut == "imprime"
                imprimee = db.scalar(select(Journal).where(Journal.carte_id == carte_id, Journal.action == "imprimee"))
                assert imprimee is not None and _POSTE in imprimee.details
                relais.revoquer(db, poste_id)
            assert _appel(client, "/annonce", {"imprimantes": []}).status_code == 401
    finally:
        _nettoyer()
