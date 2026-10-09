"""Connexion, déconnexion, changement de mot de passe."""

from __future__ import annotations

import re
import secrets

from fastapi import APIRouter, Depends, Form, Request
from fastapi.responses import RedirectResponse
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.deps import Redirection, exiger_connecte, get_db, maison, utilisateur_courant
from app.models import Utilisateur
from app.security import hash_mot_de_passe, verifier_mot_de_passe
from app.services.comptes import doit_choisir_mot_de_passe, mot_de_passe_depart
from app.services.limite import autoriser
from app.ui import csrf_valide, flash, render, retour_sur

router = APIRouter()

_HASH_FICTIF = hash_mot_de_passe("compte-fictif-africard")
_SUIVANT = re.compile(
    r"^/(verif/[A-Za-z0-9-]{3,40}\?t=[A-Za-z0-9_\-]{20,120}|m/[A-Za-z0-9_\-]{16,80})$"
)


_PORTAIL = "/portail/cartes"


def _destination(role: str, suivant: str = "") -> str:
    chemin = suivant or ""
    if chemin.startswith(_PORTAIL + "/"):
        chemin = chemin[len(_PORTAIL):]
    if _SUIVANT.match(chemin):
        return chemin
    return maison(role)


def _adresse(request: Request) -> str:
    return request.client.host if request.client else "0"


@router.get("/")
def accueil(request: Request, db: Session = Depends(get_db)):
    utilisateur = utilisateur_courant(request, db)
    if utilisateur is None:
        raise Redirection("/login")
    raise Redirection(maison(utilisateur.role))


@router.get("/login")
def login_page(request: Request, suivant: str = "", db: Session = Depends(get_db)):
    utilisateur = utilisateur_courant(request, db)
    if utilisateur is not None:
        raise Redirection(_destination(utilisateur.role, suivant))
    return render(request, "login.html", suivant=suivant if _SUIVANT.match(suivant) else "")


@router.post("/login")
def login(
    request: Request,
    identifiant: str = Form(""),
    mot_de_passe: str = Form(""),
    csrf: str = Form(""),
    suivant: str = Form(""),
    db: Session = Depends(get_db),
):
    if not csrf_valide(request, csrf):
        flash(request, "erreur", "Formulaire expiré. Rechargez la page.")
        return RedirectResponse("/login", status_code=303)

    cle = f"login:{_adresse(request)}:{identifiant.strip().lower()[:80]}"
    if not autoriser(cle, 8, 600):
        flash(request, "erreur", "Trop d'essais. Réessayez dans quelques minutes.")
        return RedirectResponse("/login", status_code=303)

    utilisateur = db.scalar(
        select(Utilisateur).where(func.lower(Utilisateur.identifiant) == identifiant.strip().lower())
    )
    stocke = utilisateur.mot_de_passe_hash if utilisateur else _HASH_FICTIF
    correct = verifier_mot_de_passe(mot_de_passe, stocke)
    if utilisateur is None or not utilisateur.actif or not correct:
        flash(request, "erreur", "Identifiant ou mot de passe incorrect.")
        return RedirectResponse("/login", status_code=303)

    request.session.clear()
    request.session["uid"] = utilisateur.id
    request.session["csrf"] = secrets.token_urlsafe(32)
    if doit_choisir_mot_de_passe(utilisateur):
        return RedirectResponse("/compte", status_code=303)
    return RedirectResponse(_destination(utilisateur.role, suivant), status_code=303)


@router.post("/logout")
def logout(request: Request, csrf: str = Form("")):
    if csrf_valide(request, csrf):
        request.session.clear()
    return RedirectResponse("/login", status_code=303)


@router.get("/compte")
def compte(request: Request, utilisateur: Utilisateur = Depends(exiger_connecte)):
    return render(request, "compte.html", user=utilisateur)


@router.post("/compte")
def changer_mot_de_passe(
    request: Request,
    actuel: str = Form(""),
    nouveau: str = Form(""),
    confirmation: str = Form(""),
    csrf: str = Form(""),
    utilisateur: Utilisateur = Depends(exiger_connecte),
    db: Session = Depends(get_db),
):
    if not csrf_valide(request, csrf):
        flash(request, "erreur", "Formulaire expiré. Rechargez la page.")
        raise Redirection("/compte")
    if not verifier_mot_de_passe(actuel, utilisateur.mot_de_passe_hash):
        flash(request, "erreur", "Le mot de passe actuel est incorrect.")
        raise Redirection("/compte")
    if len(nouveau) < 10 or len(nouveau) > 200:
        flash(request, "erreur", "Le nouveau mot de passe doit contenir au moins 10 caractères.")
        raise Redirection("/compte")
    if nouveau != confirmation:
        flash(request, "erreur", "Les deux nouveaux mots de passe ne sont pas identiques.")
        raise Redirection("/compte")
    if nouveau.lower() == utilisateur.identifiant.lower():
        flash(request, "erreur", "Le mot de passe ne doit pas être identique à l'identifiant.")
        raise Redirection("/compte")
    if nouveau == mot_de_passe_depart():
        flash(request, "erreur", "Choisissez un mot de passe différent du mot de passe de départ.")
        raise Redirection("/compte")
    premiere_fois = doit_choisir_mot_de_passe(utilisateur)
    utilisateur.mot_de_passe_hash = hash_mot_de_passe(nouveau)
    utilisateur.doit_changer_mot_de_passe = False
    db.commit()
    flash(request, "ok", "Mot de passe modifié.")
    raise Redirection(maison(utilisateur.role) if premiere_fois else "/compte")
