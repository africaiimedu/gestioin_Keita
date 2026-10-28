"""Atelier : la carte au centre, la base en dessous, comme un logiciel d'impression."""

from __future__ import annotations

import json
import re
from pathlib import Path

from fastapi import APIRouter, BackgroundTasks, Depends, File, Form, Request, UploadFile
from fastapi.responses import JSONResponse
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.config import ROOT, base_url
from app.deps import exiger_bureau, get_db
from app.models import Etudiant, Personnel, Utilisateur
from app.services.cantine import crediter, poser_abonnement
from app.services.designs import asset_valide, enregistrer_design, lister_designs, supprimer_design, url_design
from app.services.import_etudiants import controler_fiche
from app.services.metier import (
    badge_courant,
    courante_parmi,
    creer_etudiant,
    creer_personnel,
    modifier_etudiant,
    modifier_personnel,
)
from app.services.ecoles import libelle_niveau
from app.services.pdf_carte import charger_modele, code_controle, ecrire_modele, url_affichee
from app.services.statut import statut_effectif
from app.services.universite_api import (
    _matricule_cle,
    api_configuree,
    appliquer_fiches,
    completer_photos,
    synchro_etudiants,
    validite_connue,
)
from app.ui import csrf_valide

router = APIRouter(prefix="/admin/api")

_ORIGINE = ROOT / "config" / "modele_origine.json"
_ORIGINE_PERSONNEL = ROOT / "config" / "modele_personnel_origine.json"
_TYPES = {"image", "photo", "qr", "codebarres", "rect", "cercle", "ligne", "piste", "champ", "texte", "guilloche", "rosette", "micro"}
_CHAMPS = {
    "nom", "prenom", "matricule", "filiere", "fonction", "ecole", "programme", "niveau", "email",
    "annee_academique", "date_validite", "url", "edition", "controle", "qualite", "sceau",
}
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
                asset = str(obj.get("asset") or "marque")
                if not asset_valide(asset):
                    # Design retiré : on garde le logo officiel plutôt que de casser le modèle.
                    asset = "marque"
                obj["asset"] = asset
                ajustement = str(obj.get("ajustement") or "contain")
                if ajustement not in ("contain", "cover"):
                    raise ValueError("Ajustement d'image inconnu.")
                obj["ajustement"] = ajustement
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
                "ajustement", "verrou", "lisible", "initiales", "police", "interligne",
                "approche", "contenu", "fond", "cadre", "sens",
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
        "programme": getattr(etudiant, "programme", None) or "",
        "niveau": getattr(etudiant, "niveau", None) or "",
        "annee_academique": etudiant.annee_academique,
        "date_validite": etudiant.date_validite.isoformat(),
        "photo": bool(etudiant.photo_chemin),
        "statut": statut_effectif(carte.statut, carte.date_validite) if carte else "",
        "edition": carte.numero_edition if carte else 1,
        "email": etudiant.email or "",
        "sexe": etudiant.sexe if etudiant.sexe in {"M", "F"} else "M",
        "solde_cantine": int(etudiant.solde_cantine or 0),
        "abonne_cantine": bool(getattr(etudiant, "abonne_cantine", False)),
        "url": url_affichee(base_url(), etudiant.matricule),
        "controle": code_controle(carte.jeton) if carte else "",
    }


def _ligne_personnel(personne: Personnel, db: Session) -> dict:
    badge = badge_courant(db, personne.id)
    sexe = personne.sexe if personne.sexe in {"M", "F"} else "M"
    return {
        "id": personne.id,
        "prenom": personne.prenom,
        "nom": personne.nom,
        "matricule": personne.numero,
        "fonction": personne.fonction,
        "filiere": personne.fonction,
        "annee_academique": personne.annee_academique,
        "date_validite": personne.date_validite.isoformat(),
        "photo": bool(personne.photo_chemin),
        "statut": statut_effectif(badge.statut, badge.date_validite) if badge else "",
        "edition": badge.numero_edition if badge else 1,
        "email": personne.email or "",
        "sexe": sexe,
        "url": url_affichee(base_url(), personne.numero),
        "controle": code_controle(badge.jeton) if badge else "",
        "qualite": "Collaboratrice" if sexe == "F" else "Collaborateur",
    }


@router.get("/atelier")
def atelier(
    background: BackgroundTasks,
    admin: Utilisateur = Depends(exiger_bureau),
    db: Session = Depends(get_db),
):
    bilan = appliquer_fiches(db, acteur_id=admin.id)
    photos = bilan.get("photos_a_prendre") or []
    if photos:
        background.add_task(completer_photos, photos, admin.id)
    etudiants = db.scalars(
        select(Etudiant).options(selectinload(Etudiant.cartes)).order_by(Etudiant.nom, Etudiant.prenom)
    ).all()
    return {
        "etudiants": [_ligne(e) for e in etudiants],
        "modele": charger_modele(),
        "synchro_universite": api_configuree(),
    }


@router.post("/atelier/synchro-universite")
async def atelier_synchro_universite(
    request: Request,
    background: BackgroundTasks,
    admin: Utilisateur = Depends(exiger_bureau),
    db: Session = Depends(get_db),
):
    """Remplace la base atelier par l'intersection API Université et comptes étudiants."""
    if not _verifier_csrf(request):
        return JSONResponse({"message": "Formulaire expiré. Rechargez la page."}, status_code=400)
    if not api_configuree():
        return JSONResponse(
            {"message": "Clé API Université absente (UNIVERSITE_API_KEY dans Afrcaiim Card/.env)."},
            status_code=503,
        )
    try:
        corps = await request.json()
    except Exception:
        corps = {}
    bruts_comptes = corps.get("matricules_comptes") if isinstance(corps, dict) else None
    comptes = None
    if isinstance(bruts_comptes, list):
        comptes = {_matricule_cle(str(valeur)) for valeur in bruts_comptes if _matricule_cle(str(valeur))}
    retirer = True
    if isinstance(corps, dict) and "retirer" in corps:
        retirer = bool(corps.get("retirer"))
    try:
        bilan = synchro_etudiants(db, acteur_id=admin.id, matricules_comptes=comptes, retirer=retirer)
    except RuntimeError as exc:
        return JSONResponse({"message": str(exc)}, status_code=502)
    photos = bilan.pop("photos_a_prendre", [])
    if photos:
        background.add_task(completer_photos, photos, admin.id)
    etudiants = db.scalars(
        select(Etudiant).options(selectinload(Etudiant.cartes)).order_by(Etudiant.nom, Etudiant.prenom)
    ).all()
    return {
        **bilan,
        "etudiants": [_ligne(e) for e in etudiants],
        "modele": charger_modele(),
    }


@router.get("/atelier-personnel")
def atelier_personnel_api(admin: Utilisateur = Depends(exiger_bureau), db: Session = Depends(get_db)):
    personnes = db.scalars(select(Personnel).order_by(Personnel.nom, Personnel.prenom)).all()
    return {
        "etudiants": [_ligne_personnel(p, db) for p in personnes],
        "modele": charger_modele("modele_personnel.json"),
    }


@router.post("/modele")
async def enregistrer_modele(request: Request, admin: Utilisateur = Depends(exiger_bureau)):
    if not _verifier_csrf(request):
        return JSONResponse({"message": "Formulaire expiré. Rechargez la page."}, status_code=400)
    try:
        propre = _valider_modele(await request.json())
    except (ValueError, TypeError, KeyError) as exc:
        return JSONResponse({"message": str(exc)}, status_code=400)
    ecrire_modele(propre)
    return {"ok": True}


@router.post("/modele/origine")
async def restaurer_modele(request: Request, admin: Utilisateur = Depends(exiger_bureau)):
    if not _verifier_csrf(request):
        return JSONResponse({"message": "Formulaire expiré. Rechargez la page."}, status_code=400)
    origine = _lire(_ORIGINE)
    ecrire_modele(origine)
    return origine


@router.post("/modele-personnel")
async def enregistrer_modele_personnel(request: Request, admin: Utilisateur = Depends(exiger_bureau)):
    if not _verifier_csrf(request):
        return JSONResponse({"message": "Formulaire expiré. Rechargez la page."}, status_code=400)
    try:
        propre = _valider_modele(await request.json())
    except (ValueError, TypeError, KeyError) as exc:
        return JSONResponse({"message": str(exc)}, status_code=400)
    # Jamais lié à l'atelier étudiants : badges personnel uniquement en portrait.
    propre["orientation"] = "portrait"
    ecrire_modele(propre, "modele_personnel.json")
    return {"ok": True}


@router.post("/modele-personnel/origine")
async def restaurer_modele_personnel(request: Request, admin: Utilisateur = Depends(exiger_bureau)):
    if not _verifier_csrf(request):
        return JSONResponse({"message": "Formulaire expiré. Rechargez la page."}, status_code=400)
    origine = _lire(_ORIGINE_PERSONNEL)
    ecrire_modele(origine, "modele_personnel.json")
    return origine


@router.post("/personnel")
async def ajouter_personnel(request: Request, admin: Utilisateur = Depends(exiger_bureau), db: Session = Depends(get_db)):
    if not _verifier_csrf(request):
        return JSONResponse({"message": "Formulaire expiré. Rechargez la page."}, status_code=400)
    corps = await request.json()
    try:
        personne = creer_personnel(
            db,
            prenom=corps.get("prenom", ""),
            nom=corps.get("nom", ""),
            fonction=corps.get("fonction") or corps.get("filiere") or "",
            email=corps.get("email", ""),
            sexe=corps.get("sexe", "M"),
            acteur_id=admin.id,
        )
    except ValueError as exc:
        return JSONResponse({"message": str(exc)}, status_code=400)
    return _ligne_personnel(personne, db)


@router.post("/personnel/{personnel_id}")
async def modifier_personnel_api(
    personnel_id: int,
    request: Request,
    admin: Utilisateur = Depends(exiger_bureau),
    db: Session = Depends(get_db),
):
    if not _verifier_csrf(request):
        return JSONResponse({"message": "Formulaire expiré. Rechargez la page."}, status_code=400)
    personne = db.get(Personnel, personnel_id)
    if personne is None:
        return JSONResponse({"message": "Fiche personnel introuvable."}, status_code=404)
    corps = await request.json()
    try:
        fonction = (corps.get("fonction") or corps.get("filiere") or personne.fonction or "").strip()
        if len(fonction) < 2:
            raise ValueError("Indiquez la fonction ou le service.")
        modifier_personnel(
            db,
            personne,
            prenom=corps.get("prenom", personne.prenom),
            nom=corps.get("nom", personne.nom),
            fonction=fonction,
            email=corps.get("email", personne.email or ""),
            sexe=corps.get("sexe", personne.sexe),
            acteur_id=admin.id,
        )
    except ValueError as exc:
        return JSONResponse({"message": str(exc)}, status_code=400)
    return _ligne_personnel(personne, db)


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
        etudiant, secret, _compte = creer_etudiant(
            db,
            prenom=fiche.prenom,
            nom=fiche.nom,
            matricule=fiche.matricule,
            filiere=fiche.filiere,
            annee_academique=fiche.annee_academique,
            date_validite=validite_connue(fiche.matricule) or fiche.date_validite,
            programme=str(corps.get("programme") or "").strip()[:200],
            niveau=libelle_niveau(corps.get("niveau")),
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
            date_validite=validite_connue(etudiant.matricule) or fiche.date_validite,
            email=fiche.email,
            programme=str(corps.get("programme", getattr(etudiant, "programme", "") or "")).strip()[:200],
            niveau=libelle_niveau(corps.get("niveau", getattr(etudiant, "niveau", "") or "")),
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


@router.post("/etudiants/{etudiant_id}/abonnement")
async def abonner(
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
    poser_abonnement(db, etudiant, admin.id)
    etudiant = db.scalar(
        select(Etudiant).options(selectinload(Etudiant.cartes)).where(Etudiant.id == etudiant_id)
    )
    return _ligne(etudiant)


@router.get("/designs")
def api_liste_designs(admin: Utilisateur = Depends(exiger_bureau)):
    return {
        "designs": [
            {**item, "url": url_design(item["id"])}
            for item in lister_designs()
        ]
    }


@router.post("/designs")
async def api_importer_design(
    request: Request,
    fichier: UploadFile = File(...),
    nom: str = Form(""),
    admin: Utilisateur = Depends(exiger_bureau),
):
    if not _verifier_csrf(request):
        return JSONResponse({"message": "Formulaire expiré. Rechargez la page."}, status_code=400)
    try:
        fiche = enregistrer_design(await fichier.read(), nom_affiche=nom, nom_fichier=fichier.filename or "")
    except ValueError as exc:
        return JSONResponse({"message": str(exc)}, status_code=400)
    return {**fiche, "url": url_design(fiche["id"]), "asset": f"design:{fiche['id']}"}


@router.delete("/designs/{design_id}")
async def api_supprimer_design(design_id: str, request: Request, admin: Utilisateur = Depends(exiger_bureau)):
    if not _verifier_csrf(request):
        return JSONResponse({"message": "Formulaire expiré. Rechargez la page."}, status_code=400)
    if not supprimer_design(design_id):
        return JSONResponse({"message": "Design introuvable."}, status_code=404)
    return {"ok": True}
