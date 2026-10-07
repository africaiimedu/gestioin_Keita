"""Qui a le droit d'ouvrir quelle page."""

from __future__ import annotations

from fastapi import Depends, Request
from sqlalchemy.orm import Session

from app.database import SessionLocal
from app.models import Utilisateur


class Redirection(Exception):
    def __init__(self, url: str):
        self.url = url


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def utilisateur_courant(request: Request, db: Session) -> Utilisateur | None:
    uid = request.session.get("uid")
    if not uid:
        return None
    utilisateur = db.get(Utilisateur, uid)
    if utilisateur is None or not utilisateur.actif:
        return None
    return utilisateur


def utilisateur_optionnel(request: Request, db: Session = Depends(get_db)) -> Utilisateur | None:
    return utilisateur_courant(request, db)


def maison(role: str) -> str:
    if role == "admin":
        return "/admin"
    if role == "scolarite":
        return "/admin/etudiants"
    if role == "cuisiniere":
        return "/cantine"
    if role == "securite":
        return "/securite"
    return "/espace"


def _exiger(request: Request, db: Session, roles: set[str]) -> Utilisateur:
    utilisateur = utilisateur_courant(request, db)
    if utilisateur is None:
        raise Redirection("/login")
    if utilisateur.role not in roles:
        raise Redirection(maison(utilisateur.role))
    return utilisateur


def exiger_admin(
    request: Request,
    db: Session = Depends(get_db),
) -> Utilisateur:
    """Seul l'administrateur crée les comptes du personnel."""
    return _exiger(request, db, {"admin"})


def exiger_bureau(
    request: Request,
    db: Session = Depends(get_db),
) -> Utilisateur:
    """Scolarité et administrateur : étudiants, cartes, impression."""
    return _exiger(request, db, {"admin", "scolarite"})


def exiger_cuisiniere(
    request: Request,
    db: Session = Depends(get_db),
) -> Utilisateur:
    """La cuisinière tient la cantine. L'administrateur y a aussi accès."""
    return _exiger(request, db, {"cuisiniere", "admin"})


def exiger_securite(
    request: Request,
    db: Session = Depends(get_db),
) -> Utilisateur:
    return _exiger(request, db, {"securite", "admin"})


def exiger_etudiant(
    request: Request,
    db: Session = Depends(get_db),
) -> Utilisateur:
    utilisateur = utilisateur_courant(request, db)
    if utilisateur is None:
        raise Redirection("/login")
    if utilisateur.role != "etudiant" or not utilisateur.etudiant_id:
        raise Redirection(maison(utilisateur.role))
    return utilisateur


def exiger_connecte(
    request: Request,
    db: Session = Depends(get_db),
) -> Utilisateur:
    utilisateur = utilisateur_courant(request, db)
    if utilisateur is None:
        raise Redirection("/login")
    return utilisateur
