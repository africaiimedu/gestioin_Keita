"""Réception des matricules envoyés par le site de l'université."""

from __future__ import annotations

import re
import secrets

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import env
from app.deps import get_db, utilisateur_courant
from app.models import Etudiant, Utilisateur
from app.services.import_etudiants import _MATRICULE, controler_fiche
from app.services.comptes import ADRESSE, aligner_compte
from app.services.metier import creer_etudiant, journaliser, modifier_etudiant, supprimer_etudiant

router = APIRouter()


def _jeton_accepte(request: Request) -> bool:
    attendu = env("INSCRIPTION_JETON")
    recu = request.headers.get("x-jeton") or ""
    return len(attendu) >= 16 and len(attendu) == len(recu) and secrets.compare_digest(attendu, recu)


def _matricule_propre(valeur: str) -> str:
    return re.sub(r"\s+", "", valeur or "").upper()


def _adresse_du_compte(db: Session, etudiant: Etudiant) -> str:
    compte = db.scalar(select(Utilisateur.identifiant).where(Utilisateur.etudiant_id == etudiant.id))
    return compte if compte and ADRESSE.match(compte) else ""


def _retirer_matricule(db: Session, matricule: str):
    propre = _matricule_propre(matricule)
    if not _MATRICULE.match(propre):
        return JSONResponse({"message": "le matricule doit ressembler à UA26AT0001 (lettres, chiffres, tirets)."}, status_code=400)
    etudiant = db.scalar(select(Etudiant).where(Etudiant.matricule == propre))
    if etudiant is None:
        return {"matricule": propre, "supprime": False}
    supprimer_etudiant(db, etudiant)
    return {"matricule": propre, "supprime": True}


@router.delete("/api/inscriptions/{matricule}")
def retirer_inscription(matricule: str, request: Request, db: Session = Depends(get_db)):
    if not _jeton_accepte(request):
        return JSONResponse({"message": "Jeton refusé."}, status_code=401)
    return _retirer_matricule(db, matricule)


@router.post("/api/inscriptions")
async def inscrire(request: Request, db: Session = Depends(get_db)):
    if not _jeton_accepte(request):
        return JSONResponse({"message": "Jeton refusé."}, status_code=401)
    corps = await request.json()
    if corps.get("supprime") is True:
        return _retirer_matricule(db, str(corps.get("matricule") or ""))
    try:
        fiche = controler_fiche(
            corps.get("prenom", ""),
            corps.get("nom", ""),
            corps.get("matricule", ""),
            corps.get("ecole") or corps.get("filiere", ""),
            "",
            None,
            corps.get("email"),
            corps.get("sexe"),
        )
    except ValueError as exc:
        return JSONResponse({"message": str(exc)}, status_code=400)
    compte = str(corps.get("compte") or "").strip().lower()
    if compte and not ADRESSE.match(compte):
        return JSONResponse({"message": "L'adresse du compte doit finir par @univ-africaiim.com."}, status_code=400)
    if not fiche.email and compte:
        fiche.email = compte
    existant = db.scalar(select(Etudiant).where(Etudiant.matricule == fiche.matricule))
    ancien = _matricule_propre(str(corps.get("ancien_matricule") or ""))
    if ancien and ancien != fiche.matricule:
        renomme = db.scalar(select(Etudiant).where(Etudiant.matricule == ancien))
        if renomme is not None:
            if existant is not None:
                return JSONResponse({"message": f"Le matricule {fiche.matricule} existe déjà dans les cartes."}, status_code=409)
            renomme.matricule = fiche.matricule
            journaliser(db, "matricule_modifie", etudiant_id=renomme.id, details=f"{ancien} → {fiche.matricule}")
            existant = renomme
    if existant is None:
        try:
            etudiant, _secret, _compte = creer_etudiant(
                db,
                prenom=fiche.prenom,
                nom=fiche.nom,
                matricule=fiche.matricule,
                filiere=fiche.filiere,
                annee_academique=fiche.annee_academique,
                date_validite=fiche.date_validite,
                email=fiche.email,
                sexe=fiche.sexe or "M",
                identifiant=compte or None,
                action="importee",
                details="Inscription reçue du site",
            )
        except ValueError as exc:
            return JSONResponse({"message": str(exc)}, status_code=409)
    else:
        if compte:
            try:
                if aligner_compte(db, existant, compte):
                    journaliser(db, "compte_etudiant", etudiant_id=existant.id, details=compte)
            except ValueError as exc:
                db.rollback()
                return JSONResponse({"message": str(exc)}, status_code=409)
        modifier_etudiant(
            db,
            existant,
            prenom=fiche.prenom,
            nom=fiche.nom,
            filiere=fiche.filiere,
            annee_academique=fiche.annee_academique,
            date_validite=fiche.date_validite,
            email=fiche.email or existant.email or _adresse_du_compte(db, existant),
            sexe=fiche.sexe,
            acteur_id=None,
        )
        etudiant = existant
    return {
        "matricule": etudiant.matricule,
        "compte": compte or None,
        "ecole": fiche.filiere,
        "annee_academique": fiche.annee_academique,
    }


@router.get("/api/portail/session")
def etat_portail(request: Request, db: Session = Depends(get_db)):
    utilisateur = utilisateur_courant(request, db)
    if utilisateur is None:
        return JSONResponse({"ok": False}, status_code=401)
    return {"ok": True, "role": utilisateur.role}


@router.post("/api/portail")
async def ouvrir_portail(request: Request, db: Session = Depends(get_db)):
    """Ouvre la session des cartes pour le personnel déjà connecté à la scolarité."""
    if not _jeton_accepte(request):
        return JSONResponse({"message": "Jeton refusé."}, status_code=401)
    try:
        corps = await request.json()
    except Exception:
        corps = {}
    roles = ("admin", "scolarite", "cuisiniere", "securite")
    voulu = corps.get("role") if corps.get("role") in roles else "scolarite"
    utilisateur = db.scalar(
        select(Utilisateur).where(Utilisateur.role == voulu, Utilisateur.actif.is_(True)).limit(1)
    )
    if utilisateur is None and voulu != "admin":
        utilisateur = db.scalar(
            select(Utilisateur).where(Utilisateur.role == "admin", Utilisateur.actif.is_(True)).limit(1)
        )
    if utilisateur is None:
        return JSONResponse({"message": "Aucun compte cartes."}, status_code=404)
    request.session["uid"] = utilisateur.id
    request.session["csrf"] = secrets.token_urlsafe(32)
    return {"ok": True, "role": utilisateur.role}
