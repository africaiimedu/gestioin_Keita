"""Pages HTML et protections de formulaire."""

from __future__ import annotations

import secrets
from datetime import date, datetime, timezone

from fastapi.templating import Jinja2Templates
from starlette.requests import Request

from app.config import ROOT, charger_config
from app.services.courrier import formater_francs
from app.services.ecoles import ECOLES, annee_academique_courante
from app.services.import_etudiants import validite_par_defaut
from app.services.menu_cantine import image_plat
from app.services.statut import libelle_action, libelle_role, libelle_statut

templates = Jinja2Templates(directory=str(ROOT / "templates"))


def _datefr(valeur):
    if valeur is None:
        return ""
    if isinstance(valeur, datetime):
        if valeur.tzinfo is None:
            valeur = valeur.replace(tzinfo=timezone.utc)
        return valeur.astimezone().strftime("%d/%m/%Y %H:%M")
    if isinstance(valeur, date):
        return valeur.strftime("%d/%m/%Y")
    return str(valeur)


templates.env.filters["datefr"] = _datefr
templates.env.filters["gnf"] = formater_francs
templates.env.globals["ecoles"] = ECOLES
templates.env.globals["annee_courante"] = annee_academique_courante
templates.env.globals["validite_courante"] = lambda: validite_par_defaut(annee_academique_courante())
templates.env.filters["statutfr"] = libelle_statut
templates.env.filters["actionfr"] = libelle_action
templates.env.filters["rolefr"] = libelle_role
templates.env.globals["image_plat"] = image_plat


def assurer_csrf(request: Request) -> str:
    jeton = request.session.get("csrf")
    if not jeton:
        jeton = secrets.token_urlsafe(32)
        request.session["csrf"] = jeton
    return jeton


def csrf_valide(request: Request, recu: str | None) -> bool:
    attendu = request.session.get("csrf") or ""
    recu = recu or ""
    if len(attendu) < 16 or len(attendu) != len(recu):
        return False
    return secrets.compare_digest(attendu, recu)


def flash(request: Request, type_: str, message: str) -> None:
    request.session["flash"] = {"type": type_, "message": message}


def retour_sur(request: Request, defaut: str = "/") -> str:
    ref = request.headers.get("referer", "")
    hote = request.headers.get("host", "")
    if not hote:
        return defaut
    for prefixe in (f"https://{hote}", f"http://{hote}"):
        if ref == prefixe or ref.startswith(prefixe + "/"):
            return ref
    return defaut


def render(request: Request, modele: str, **contexte):
    contexte.setdefault("user", None)
    contexte["request"] = request
    contexte["csrf"] = assurer_csrf(request)
    contexte["flash"] = request.session.pop("flash", None)
    contexte["cfg"] = charger_config()
    return templates.TemplateResponse(request, modele, contexte)
