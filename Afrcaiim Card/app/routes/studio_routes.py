"""Atelier : la carte au centre, la base en dessous, comme un logiciel d'impression."""

from __future__ import annotations

import json
import re

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.config import ROOT, base_url
from app.deps import exiger_bureau, get_db
from app.models import Etudiant, Utilisateur
from app.services.cantine import crediter
from app.services.import_etudiants import controler_fiche
from app.services.metier import courante_parmi, creer_etudiant, modifier_etudiant
from app.services.pdf_carte import code_controle, url_affichee
from app.services.statut import statut_effectif
from app.ui import csrf_valide

router = APIRouter(prefix="/admin/api")

_MODELE = ROOT / "config" / "modele.json"
_ORIGINE = ROOT / "config" / "modele_origine.json"
_TYPES = {"image", "photo", "qr", "codebarres", "rect", "cercle", "ligne", "piste", "champ", "texte", "guilloche", "rosette", "micro"}
_CHAMPS = {"nom", "prenom", "matricule", "filiere", "ecole", "email", "annee_academique", "date_validite", "url", "edition", "controle", "qualite"}
_HEX = re.compile(r"^#[0-9A-Fa-f]{6}$")
_BOOLS = ("gras", "italique", "souligne", "majuscules", "retour", "verrou", "lisible", "initiales", "cadre")
_CONTENUS_QR = {"securise", *_CHAMPS}


def _lire(chemin: Path) -> dict:
    with open(chemin, encoding="utf-8") as fichier:
        return json.load(fichier)


def _verifier_csrf(request: Request) -> bool:
    return csrf_valide(request, request.headers.get("x-csrf"))


def _valider_modele(data: dict) -> dict:
    if not isinstance(data, dict) or not {"recto", "verso"} <= set(data.keys()) <= {"recto", "verso", "orientation"}:
        raise ValueError("Le modèle doit contenir le recto et le verso.")
    orientation = str(data.get("orientation") or "paysage")
    if orientation not in ("paysage", "portrait"):
        raise ValueError("L'orientation est paysage ou portrait.")
    data["orientation"] = orientation
    for face in ("recto", "verso"):
        objets = data[face]
        if not isinstance(objets, list) or len(objets) > 80:
            raise ValueError("Trop d'objets sur la carte.")
        propres = []
        for obj in objets:
            if not isinstance(obj, dict) or obj.get("type") not in _TYPES:
                raise ValueError("Un objet de la carte n'est pas reconnu.")
            for cle in ("x", "y", "w", "h"):
                valeur = float(obj[cle])
                if valeur < -2 or valeur > 120:
                    raise ValueError("Un objet sort de la carte.")
                obj[cle] = round(valeur, 2)
            if obj["type"] == "image":
                obj["asset"] = "marque"
            if obj["type"] in ("champ", "codebarres", "micro", "qr") and obj.get("champ") not in (None, *_CHAMPS):
                raise ValueError("Champ de base inconnu.")
            if obj["type"] == "qr":
                contenu = str(obj.get("contenu") or "securise")
                if contenu not in _CONTENUS_QR:
                    raise ValueError("Le QR ne peut contenir qu'une vérification sécurisée ou un champ de la fiche.")
                obj["contenu"] = contenu
            for cle in ("couleur", "couleur_texte", "contour", "fond"):
                if obj.get(cle) and not _HEX.match(str(obj[cle])):
                    raise ValueError("Couleur invalide.")
            if obj.get("align") not in (None, "left", "center", "right", "justify"):
                raise ValueError("Alignement inconnu.")
            if obj.get("sens") not in (None, "horizontal", "vertical"):
                raise ValueError("Sens du code-barres inconnu.")
            if obj.get("police") not in (None, "sans", "serif"):
                raise ValueError("Police inconnue.")
            if "texte" in obj:
                obj["texte"] = str(obj["texte"])[:500]
            if "personnalise" in obj:
                obj["personnalise"] = str(obj["personnalise"])[:500]
            if "interligne" in obj:
                obj["interligne"] = round(min(3, max(0.8, float(obj["interligne"]))), 2)
            if "approche" in obj:
                obj["approche"] = round(min(8, max(-1, float(obj["approche"]))), 2)
            if "taille" in obj:
                obj["taille"] = round(min(32, max(1.2, float(obj["taille"]))), 2)
            if "rayon" in obj:
                obj["rayon"] = round(min(20, max(0, float(obj["rayon"]))), 2)
            if "epaisseur" in obj:
                obj["epaisseur"] = round(min(2, max(0.05, float(obj["epaisseur"]))), 2)
            for cle in _BOOLS:
                if cle in obj:
                    obj[cle] = bool(obj[cle])
            identifiant = re.sub(r"[^a-zA-Z0-9_-]", "", str(obj.get("id") or "objet"))[:40]
            obj["id"] = identifiant or "objet"
            gardes = (
                "id", "type", "x", "y", "w", "h", "couleur", "couleur_texte", "contour",
                "epaisseur", "rayon", "taille", "gras", "italique", "souligne", "align",
                "majuscules", "retour", "texte", "personnalise", "champ", "asset",
                "verrou", "lisible", "initiales", "police", "interligne", "approche",
                "contenu", "fond", "cadre", "sens",
            )
            propres.append({cle: obj[cle] for cle in gardes if cle in obj and obj[cle] is not None})
        data[face] = propres
    return data


def _ligne(etudiant: Etudiant) -> dict:
    carte = courante_parmi(etudiant.cartes)
    return {
        "id": etudiant.id,
        "prenom": etudiant.prenom,
        "nom": etudiant.nom,
        "matricule": etudiant.matricule,
        "filiere": etudiant.filiere,
        "annee_academique": etudiant.annee_academique,
        "date_validite": etudiant.date_validite.isoformat(),
        "photo": bool(etudiant.photo_chemin),
        "statut": statut_effectif(carte.statut, carte.date_validite) if carte else "",
        "edition": carte.numero_edition if carte else 1,
        "email": etudiant.email or "",
        "sexe": etudiant.sexe if etudiant.sexe in {"M", "F"} else "M",
        "solde_cantine": int(etudiant.solde_cantine or 0),
        "url": url_affichee(base_url(), etudiant.matricule),
        "controle": code_controle(carte.jeton) if carte else "",
    }


@router.get("/atelier")
def atelier(admin: Utilisateur = Depends(exiger_bureau), db: Session = Depends(get_db)):
    etudiants = db.scalars(
        select(Etudiant).options(selectinload(Etudiant.cartes)).order_by(Etudiant.nom, Etudiant.prenom)
    ).all()
    return {"etudiants": [_ligne(e) for e in etudiants], "modele": _lire(_MODELE)}


@router.post("/modele")
async def enregistrer_modele(request: Request, admin: Utilisateur = Depends(exiger_bureau)):
    if not _verifier_csrf(request):
        return JSONResponse({"message": "Formulaire expiré. Rechargez la page."}, status_code=400)
    try:
        propre = _valider_modele(await request.json())
    except (ValueError, TypeError, KeyError) as exc:
        return JSONResponse({"message": str(exc)}, status_code=400)
    _MODELE.write_text(json.dumps(propre, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return {"ok": True}


@router.post("/modele/origine")
async def restaurer_modele(request: Request, admin: Utilisateur = Depends(exiger_bureau)):
    if not _verifier_csrf(request):
        return JSONResponse({"message": "Formulaire expiré. Rechargez la page."}, status_code=400)
    origine = _lire(_ORIGINE)
    _MODELE.write_text(json.dumps(origine, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return origine


@router.post("/etudiants")
async def ajouter(request: Request, admin: Utilisateur = Depends(exiger_bureau), db: Session = Depends(get_db)):
    if not _verifier_csrf(request):
        return JSONResponse({"message": "Formulaire expiré. Rechargez la page."}, status_code=400)
    corps = await request.json()
    try:
        fiche = controler_fiche(
            corps.get("prenom", ""),
            corps.get("nom", ""),
            corps.get("matricule", ""),
            corps.get("filiere", ""),
            corps.get("annee_academique", ""),
            corps.get("date_validite") or None,
            sexe=corps.get("sexe", ""),
            sexe_obligatoire=True,
        )
        etudiant, secret = creer_etudiant(
            db,
            prenom=fiche.prenom,
            nom=fiche.nom,
            matricule=fiche.matricule,
            filiere=fiche.filiere,
            annee_academique=fiche.annee_academique,
            date_validite=fiche.date_validite,
            sexe=fiche.sexe,
            acteur_id=admin.id,
        )
    except ValueError as exc:
        return JSONResponse({"message": str(exc)}, status_code=400)
    db.refresh(etudiant)
    etudiant = db.scalar(
        select(Etudiant).options(selectinload(Etudiant.cartes)).where(Etudiant.id == etudiant.id)
    )
    ligne = _ligne(etudiant)
    ligne["mot_de_passe"] = secret
    return ligne


@router.post("/etudiants/{etudiant_id}")
async def modifier(
    etudiant_id: int,
    request: Request,
    admin: Utilisateur = Depends(exiger_bureau),
    db: Session = Depends(get_db),
):
    if not _verifier_csrf(request):
        return JSONResponse({"message": "Formulaire expiré. Rechargez la page."}, status_code=400)
    etudiant = db.get(Etudiant, etudiant_id)
    if etudiant is None:
        return JSONResponse({"message": "Étudiant introuvable."}, status_code=404)
    corps = await request.json()
    try:
        fiche = controler_fiche(
            corps.get("prenom", etudiant.prenom),
            corps.get("nom", etudiant.nom),
            etudiant.matricule,
            corps.get("filiere", etudiant.filiere),
            corps.get("annee_academique", etudiant.annee_academique),
            corps.get("date_validite") or etudiant.date_validite.isoformat(),
            corps.get("email", etudiant.email or ""),
        )
        modifier_etudiant(
            db,
            etudiant,
            prenom=fiche.prenom,
            nom=fiche.nom,
            filiere=fiche.filiere,
            annee_academique=fiche.annee_academique,
            date_validite=fiche.date_validite,
            email=fiche.email,
            acteur_id=admin.id,
        )
    except ValueError as exc:
        return JSONResponse({"message": str(exc)}, status_code=400)
    etudiant = db.scalar(
        select(Etudiant).options(selectinload(Etudiant.cartes)).where(Etudiant.id == etudiant_id)
    )
    return _ligne(etudiant)


@router.post("/etudiants/{etudiant_id}/cantine")
async def recharger(
    etudiant_id: int,
    request: Request,
    admin: Utilisateur = Depends(exiger_bureau),
    db: Session = Depends(get_db),
):
    if not _verifier_csrf(request):
        return JSONResponse({"message": "Formulaire expiré. Rechargez la page."}, status_code=400)
    etudiant = db.get(Etudiant, etudiant_id)
    if etudiant is None:
        return JSONResponse({"message": "Étudiant introuvable."}, status_code=404)
    corps = await request.json()
    try:
        crediter(db, etudiant, int(str(corps.get("montant", "")).strip()), admin.id)
    except (TypeError, ValueError) as exc:
        texte = str(exc)
        if "invalid literal" in texte or not texte:
            texte = "Indiquez un montant en francs guinéens, sans virgule."
        return JSONResponse({"message": texte}, status_code=400)
    etudiant = db.scalar(
        select(Etudiant).options(selectinload(Etudiant.cartes)).where(Etudiant.id == etudiant_id)
    )
    return _ligne(etudiant)
