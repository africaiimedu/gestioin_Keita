"""Comptes du personnel : l'administrateur crée, chaque rôle ouvre sa page."""

import re

from fastapi.testclient import TestClient
from sqlalchemy import delete, func, or_, select

from app.config import env
from app.database import SessionLocal
from app.main import app
from app.models import Journal, Utilisateur
from app.seed import _colonnes_cantine

_ESSAIS = ("test.scolarite", "test.cuisine", "test.porte")
_MOT = "Temporaire-2026"


def _csrf(html: str) -> str:
    trouve = re.search(r'name="csrf" value="([^"]+)"', html)
    assert trouve, html[:400]
    return trouve.group(1)


def _entrer(client: TestClient, identifiant: str, mot_de_passe: str) -> str:
    page = client.get("/login")
    reponse = client.post(
        "/login",
        data={"identifiant": identifiant, "mot_de_passe": mot_de_passe, "csrf": _csrf(page.text)},
        follow_redirects=False,
    )
    assert reponse.status_code == 303, reponse.text
    return reponse.headers["location"]


def _nettoyer() -> None:
    _colonnes_cantine()
    with SessionLocal() as db:
        comptes = db.scalars(select(Utilisateur).where(Utilisateur.identifiant.in_(_ESSAIS))).all()
        ids = [compte.id for compte in comptes]
        if ids:
            db.execute(delete(Journal).where(Journal.utilisateur_id.in_(ids)))
        db.execute(
            delete(Journal).where(
                or_(*[Journal.details.startswith(identifiant) for identifiant in _ESSAIS])
            )
        )
        if ids:
            db.execute(delete(Utilisateur).where(Utilisateur.id.in_(ids)))
        db.commit()


def test_admin_cree_les_trois_roles():
    _nettoyer()
    try:
        with TestClient(app) as client:
            with SessionLocal() as db:
                admin = db.scalar(
                    select(Utilisateur).where(func.lower(Utilisateur.identifiant) == "africaiim")
                )
                ancien = db.scalar(
                    select(Utilisateur).where(func.lower(Utilisateur.identifiant) == "scolarite")
                )
            assert admin is not None and admin.role == "admin"
            assert ancien is None or ancien.role == "scolarite"

            assert _entrer(client, env("ADMIN_IDENTIFIANT"), env("ADMIN_MOT_DE_PASSE")) == "/admin"
            page = client.get("/admin/comptes")
            assert page.status_code == 200
            assert "Scolarité" in page.text and "Cuisinière" in page.text and "Sécurité" in page.text
            cantine = client.get("/cantine/menu")
            assert cantine.status_code == 200
            assert "Menu du jour" in cantine.text
            assert "Cartes" in cantine.text and "Cuisine" in cantine.text
            assert "Comptes" in cantine.text and "Commandes" in cantine.text and "Contrôle" in cantine.text
            assert client.get("/cantine").status_code == 200
            assert client.get("/cantine/commandes").status_code == 200
            assert client.get("/securite").status_code == 200

            for identifiant, role in (
                ("test.scolarite", "scolarite"),
                ("test.cuisine", "cuisiniere"),
                ("test.porte", "securite"),
            ):
                formulaire = client.get("/admin/comptes")
                cree = client.post(
                    "/admin/comptes",
                    data={
                        "identifiant": identifiant,
                        "mot_de_passe": _MOT,
                        "confirmation": _MOT,
                        "role": role,
                        "csrf": _csrf(formulaire.text),
                    },
                    follow_redirects=False,
                )
                assert cree.status_code == 303
                assert cree.headers["location"] == "/admin/comptes"

            client.post("/logout", data={"csrf": _csrf(client.get("/admin/comptes").text)}, follow_redirects=False)

            assert _entrer(client, "test.scolarite", _MOT) == "/admin/etudiants"
            assert client.get("/admin/etudiants").status_code == 200
            assert client.get("/cantine", follow_redirects=False).headers["location"] == "/admin/etudiants"
            refuse = client.get("/admin/comptes", follow_redirects=False)
            assert refuse.status_code == 303
            assert refuse.headers["location"] == "/admin/etudiants"
            client.post("/logout", data={"csrf": _csrf(client.get("/admin/etudiants").text)}, follow_redirects=False)

            assert _entrer(client, "test.cuisine", _MOT) == "/cantine"
            assert client.get("/admin/etudiants", follow_redirects=False).headers["location"] == "/cantine"
            client.post("/logout", data={"csrf": _csrf(client.get("/cantine").text)}, follow_redirects=False)

            assert _entrer(client, "test.porte", _MOT) == "/securite"
            page = client.get("/securite")
            assert page.status_code == 200
            assert "Contrôle des cartes" in page.text
            assert client.get("/admin/comptes", follow_redirects=False).headers["location"] == "/securite"
    finally:
        _nettoyer()
