"""Carte numérique de l'étudiant."""

from fastapi import APIRouter, Depends, Request
from fastapi.responses import Response
from sqlalchemy.orm import Session

from app.config import base_url
from app.deps import exiger_etudiant, get_db
from app.models import Etudiant, Utilisateur
from app.services.metier import carte_courante, noter_generation
from app.services.pdf_carte import (
    charger_modele,
    code_controle,
    image_code128,
    image_qr,
    pdf_individuel,
    url_affichee,
    url_qr,
)
from app.services.photos import lire_photo, portrait_initiales
from app.services.statut import statut_effectif
from app.ui import render

router = APIRouter(prefix="/espace")


def _donnees(db: Session, utilisateur: Utilisateur):
    etudiant = db.get(Etudiant, utilisateur.etudiant_id)
    carte = carte_courante(db, etudiant.id) if etudiant else None
    statut = statut_effectif(carte.statut, carte.date_validite) if carte else None
    return etudiant, carte, statut


@router.get("")
def ma_carte(
    request: Request,
    utilisateur: Utilisateur = Depends(exiger_etudiant),
    db: Session = Depends(get_db),
):
    etudiant, carte, statut = _donnees(db, utilisateur)
    adresse = url_affichee(base_url(), etudiant.matricule) if etudiant else ""
    apercu = None
    if etudiant and carte:
        apercu = {
            "modele": charger_modele(),
            "etu": {
                "nom": etudiant.nom,
                "prenom": etudiant.prenom,
                "matricule": etudiant.matricule,
                "filiere": etudiant.filiere,
                "email": etudiant.email or "",
                "annee_academique": etudiant.annee_academique,
                "date_validite": etudiant.date_validite.isoformat(),
                "url": adresse,
                "edition": carte.numero_edition,
                "controle": code_controle(carte.jeton),
                "photo": bool(etudiant.photo_chemin),
            },
            "urls": {
                "photo": "/espace/photo.jpg",
                "qr": "/espace/qr.png",
                "barre": "/espace/code128.png",
            },
        }
    return render(
        request,
        "espace.html",
        user=utilisateur,
        etudiant=etudiant,
        carte=carte,
        statut=statut,
        adresse=adresse,
        apercu=apercu,
    )


@router.get("/photo.jpg")
def photo(utilisateur: Utilisateur = Depends(exiger_etudiant), db: Session = Depends(get_db)):
    etudiant, _carte, _statut = _donnees(db, utilisateur)
    if etudiant is None:
        return Response(status_code=404)
    blob = lire_photo(etudiant.photo_chemin) or portrait_initiales(etudiant.prenom, etudiant.nom)
    return Response(blob, media_type="image/jpeg", headers={"Cache-Control": "private, no-store"})


@router.get("/qr.png")
def qr(utilisateur: Utilisateur = Depends(exiger_etudiant), db: Session = Depends(get_db)):
    etudiant, carte, _statut = _donnees(db, utilisateur)
    if etudiant is None or carte is None:
        return Response(status_code=404)
    png = image_qr(url_qr(base_url(), etudiant.matricule, carte.jeton))
    return Response(png, media_type="image/png", headers={"Cache-Control": "private, no-store"})


@router.get("/code128.png")
def code128(champ: str = "matricule", utilisateur: Utilisateur = Depends(exiger_etudiant), db: Session = Depends(get_db)):
    etudiant, _carte, _statut = _donnees(db, utilisateur)
    if etudiant is None:
        return Response(status_code=404)
    valeurs = {
        "nom": etudiant.nom,
        "prenom": etudiant.prenom,
        "matricule": etudiant.matricule,
        "filiere": etudiant.filiere,
        "annee_academique": etudiant.annee_academique,
        "date_validite": etudiant.date_validite.strftime("%d/%m/%Y"),
        "url": url_affichee(base_url(), etudiant.matricule),
    }
    png = image_code128(valeurs.get(champ, etudiant.matricule))
    return Response(png, media_type="image/png", headers={"Cache-Control": "private, no-store"})


@router.get("/pdf")
def pdf(utilisateur: Utilisateur = Depends(exiger_etudiant), db: Session = Depends(get_db)):
    etudiant, carte, statut = _donnees(db, utilisateur)
    if etudiant is None or carte is None or statut != "active":
        return Response(status_code=404)
    photo = lire_photo(etudiant.photo_chemin)
    if photo is None:
        return Response(status_code=404)
    contenu = pdf_individuel(etudiant, photo, carte.jeton, carte.numero_edition, base_url())
    noter_generation(db, carte, utilisateur.id, "PDF depuis l'espace étudiant")
    return Response(
        contenu,
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'attachment; filename="carte-{etudiant.matricule}.pdf"',
            "Cache-Control": "no-store",
        },
    )
