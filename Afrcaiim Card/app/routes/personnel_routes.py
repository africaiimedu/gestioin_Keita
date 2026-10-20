"""Badges du personnel : fiches et impression portrait (mêmes paramètres que la carte étudiant)."""

from __future__ import annotations

from fastapi import APIRouter, Depends, File, Form, Request, UploadFile
from fastapi.responses import JSONResponse, Response
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.config import base_url
from app.deps import Redirection, exiger_bureau, get_db
from app.models import BadgePersonnel, Personnel, Utilisateur
from app.services.metier import (
    badge_courant,
    creer_personnel,
    journaliser,
    modifier_personnel,
    prochain_numero_personnel,
    reediter_badge,
    remplacer_photo_personnel,
)
from app.services.pdf_carte import (
    charger_modele_personnel,
    code_controle,
    image_code128,
    image_qr,
    pdf_badge_personnel,
    pdf_feuille_a4,
    url_affichee,
    url_qr,
)
from app.services.photos import lire_photo, normaliser_photo, portrait_initiales
from app.services.statut import statut_effectif
from app.ui import csrf_valide, flash, render, retour_sur

router = APIRouter(prefix="/admin/personnel")


def _exiger_csrf(request: Request, jeton: str, defaut: str) -> None:
    if not csrf_valide(request, jeton):
        flash(request, "erreur", "Formulaire expiré. Rechargez la page et réessayez.")
        raise Redirection(retour_sur(request, defaut))


def _personne(db: Session, personnel_id: int) -> Personnel:
    personne = db.get(Personnel, personnel_id)
    if personne is None:
        raise Redirection("/admin/personnel")
    return personne


def _teinte(valeur: str, defaut: str) -> str:
    texte = str(valeur or "").strip()
    if len(texte) == 6 and all(c in "0123456789abcdefABCDEF" for c in texte):
        return f"#{texte}"
    return defaut


@router.get("")
def liste(
    request: Request,
    q: str = "",
    admin: Utilisateur = Depends(exiger_bureau),
    db: Session = Depends(get_db),
):
    requete = select(Personnel).order_by(Personnel.nom, Personnel.prenom)
    terme = (q or "").strip()
    if terme:
        motif = f"%{terme}%"
        requete = requete.where(
            or_(
                Personnel.nom.ilike(motif),
                Personnel.prenom.ilike(motif),
                Personnel.numero.ilike(motif),
                Personnel.fonction.ilike(motif),
            )
        )
    personnes = db.scalars(requete).all()
    lignes = []
    for personne in personnes:
        badge = badge_courant(db, personne.id)
        lignes.append({
            "personne": personne,
            "badge": badge,
            "statut": statut_effectif(badge.statut, badge.date_validite) if badge else None,
        })
    return render(
        request,
        "admin_personnel.html",
        user=admin,
        lignes=lignes,
        q=terme,
        propose=prochain_numero_personnel(db),
    )


@router.post("")
async def creer(
    request: Request,
    prenom: str = Form(""),
    nom: str = Form(""),
    fonction: str = Form(""),
    numero: str = Form(""),
    sexe: str = Form("M"),
    email: str = Form(""),
    photo: UploadFile | None = File(None),
    csrf: str = Form(""),
    admin: Utilisateur = Depends(exiger_bureau),
    db: Session = Depends(get_db),
):
    _exiger_csrf(request, csrf, "/admin/personnel")
    jpeg = None
    if photo and photo.filename:
        try:
            jpeg = normaliser_photo(await photo.read())
        except ValueError as exc:
            flash(request, "erreur", str(exc))
            raise Redirection("/admin/personnel") from exc
    try:
        personne = creer_personnel(
            db,
            prenom=prenom,
            nom=nom,
            fonction=fonction,
            numero=numero or None,
            jpeg=jpeg,
            email=email,
            sexe=sexe,
            acteur_id=admin.id,
        )
    except ValueError as exc:
        flash(request, "erreur", str(exc))
        raise Redirection("/admin/personnel") from exc
    flash(request, "ok", f"Badge créé pour {personne.nom} {personne.prenom} ({personne.numero}).")
    raise Redirection(f"/admin/personnel/{personne.id}")


@router.get("/{personnel_id}")
def detail(
    personnel_id: int,
    request: Request,
    admin: Utilisateur = Depends(exiger_bureau),
    db: Session = Depends(get_db),
):
    personne = _personne(db, personnel_id)
    badge = badge_courant(db, personne.id)
    statut = statut_effectif(badge.statut, badge.date_validite) if badge else None
    return render(
        request,
        "admin_personnel_detail.html",
        user=admin,
        personne=personne,
        badge=badge,
        statut=statut,
    )


@router.post("/{personnel_id}")
def modifier(
    personnel_id: int,
    request: Request,
    prenom: str = Form(""),
    nom: str = Form(""),
    fonction: str = Form(""),
    email: str = Form(""),
    sexe: str = Form("M"),
    csrf: str = Form(""),
    admin: Utilisateur = Depends(exiger_bureau),
    db: Session = Depends(get_db),
):
    personne = _personne(db, personnel_id)
    _exiger_csrf(request, csrf, f"/admin/personnel/{personnel_id}")
    try:
        if len(prenom.strip()) < 2 or len(nom.strip()) < 2:
            raise ValueError("Le nom et le prénom sont obligatoires.")
        if len(fonction.strip()) < 2:
            raise ValueError("Indiquez la fonction ou le service.")
        modifier_personnel(
            db, personne,
            prenom=prenom, nom=nom, fonction=fonction, email=email, sexe=sexe, acteur_id=admin.id,
        )
    except ValueError as exc:
        flash(request, "erreur", str(exc))
        raise Redirection(f"/admin/personnel/{personnel_id}") from exc
    flash(request, "ok", "Fiche enregistrée.")
    raise Redirection(f"/admin/personnel/{personnel_id}")


@router.post("/{personnel_id}/photo")
async def photo(
    personnel_id: int,
    request: Request,
    fichier: UploadFile = File(...),
    csrf: str = Form(""),
    admin: Utilisateur = Depends(exiger_bureau),
    db: Session = Depends(get_db),
):
    personne = _personne(db, personnel_id)
    _exiger_csrf(request, csrf, f"/admin/personnel/{personnel_id}")
    try:
        jpeg = normaliser_photo(await fichier.read())
        remplacer_photo_personnel(db, personne, jpeg, admin.id)
    except ValueError as exc:
        flash(request, "erreur", str(exc))
        raise Redirection(f"/admin/personnel/{personnel_id}") from exc
    flash(request, "ok", "Photo enregistrée.")
    raise Redirection(f"/admin/personnel/{personnel_id}")


@router.post("/{personnel_id}/reediter")
def reediter(
    personnel_id: int,
    request: Request,
    csrf: str = Form(""),
    admin: Utilisateur = Depends(exiger_bureau),
    db: Session = Depends(get_db),
):
    personne = _personne(db, personnel_id)
    _exiger_csrf(request, csrf, f"/admin/personnel/{personnel_id}")
    reediter_badge(db, personne, admin.id)
    flash(request, "ok", "Nouveau badge émis. Réimprimez-le.")
    raise Redirection(f"/admin/personnel/{personnel_id}")


@router.get("/{personnel_id}/photo")
def servir_photo(personnel_id: int, admin: Utilisateur = Depends(exiger_bureau), db: Session = Depends(get_db)):
    personne = _personne(db, personnel_id)
    blob = lire_photo(personne.photo_chemin) or portrait_initiales(personne.prenom, personne.nom)
    return Response(blob, media_type="image/jpeg", headers={"Cache-Control": "no-store"})


@router.get("/{personnel_id}/pdf")
def pdf(
    personnel_id: int,
    request: Request,
    admin: Utilisateur = Depends(exiger_bureau),
    db: Session = Depends(get_db),
):
    personne = _personne(db, personnel_id)
    badge = badge_courant(db, personne.id)
    if badge is None:
        flash(request, "erreur", "Aucun badge actif.")
        raise Redirection(f"/admin/personnel/{personnel_id}")
    photo = lire_photo(personne.photo_chemin) or portrait_initiales(personne.prenom, personne.nom)
    modele = charger_modele_personnel()
    if request.query_params.get("format") == "a4":
        contenu = pdf_feuille_a4(
            [(personne, photo, badge.jeton, badge.numero_edition)],
            base_url(),
            f"Badge {personne.numero}",
            modele=modele,
        )
        nom = f"badge-{personne.numero}-a4.pdf"
    else:
        contenu = pdf_badge_personnel(personne, photo, badge.jeton, badge.numero_edition, base_url())
        nom = f"badge-{personne.numero}.pdf"
    journaliser(db, "badge_pdf", utilisateur_id=admin.id, details=nom)
    db.commit()
    return Response(
        contenu,
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'{"inline" if request.query_params.get("inline") else "attachment"}; filename="{nom}"',
            "Cache-Control": "no-store",
        },
    )


@router.get("/{personnel_id}/imprimer")
def page_imprimer(personnel_id: int, request: Request, admin: Utilisateur = Depends(exiger_bureau), db: Session = Depends(get_db)):
    """Page HTML d'impression portrait (navigateur). Les PDF restent disponibles sur la fiche."""
    personne = _personne(db, personnel_id)
    badge = badge_courant(db, personne.id)
    if badge is None:
        raise Redirection(f"/admin/personnel/{personnel_id}")
    modele = charger_modele_personnel()
    etu = {
        "nom": personne.nom,
        "prenom": personne.prenom,
        "matricule": personne.numero,
        "filiere": personne.fonction,
        "email": personne.email or "",
        "annee_academique": personne.annee_academique,
        "date_validite": personne.date_validite.isoformat(),
        "url": url_affichee(base_url(), personne.numero),
        "controle": code_controle(badge.jeton),
        "edition": badge.numero_edition,
        "sexe": personne.sexe,
        "photo": bool(personne.photo_chemin),
    }
    return render(
        request,
        "imprimer_personnel.html",
        user=admin,
        personne=personne,
        badge=badge,
        donnees={
            "modele": modele,
            "etu": etu,
            "urls": {
                "photo": f"/admin/personnel/{personne.id}/photo",
                "qr": f"/admin/personnel/{personne.id}/qr.png",
                "barre": f"/admin/personnel/{personne.id}/code128.png",
            },
        },
    )


@router.get("/{personnel_id}/qr.png")
def qr_png(
    personnel_id: int,
    contenu: str = "securise",
    encre: str = "000000",
    fond: str = "FFFFFF",
    admin: Utilisateur = Depends(exiger_bureau),
    db: Session = Depends(get_db),
):
    personne = _personne(db, personnel_id)
    badge = badge_courant(db, personne.id)
    if badge is None:
        return Response(status_code=404)
    url = url_qr(base_url(), personne.numero, badge.jeton) if contenu == "securise" else personne.numero
    return Response(
        image_qr(url, _teinte(encre, "#000000"), _teinte(fond, "#FFFFFF")),
        media_type="image/png",
        headers={"Cache-Control": "no-store"},
    )


@router.get("/{personnel_id}/code128.png")
def code128_png(
    personnel_id: int,
    champ: str = "controle",
    encre: str = "000000",
    fond: str = "FFFFFF",
    admin: Utilisateur = Depends(exiger_bureau),
    db: Session = Depends(get_db),
):
    personne = _personne(db, personnel_id)
    badge = badge_courant(db, personne.id)
    if badge is None:
        return Response(status_code=404)
    valeurs = {
        "matricule": personne.numero,
        "controle": code_controle(badge.jeton),
        "email": personne.email or "",
    }
    return Response(
        image_code128(valeurs.get(champ, personne.numero), _teinte(encre, "#000000"), _teinte(fond, "#FFFFFF")),
        media_type="image/png",
        headers={"Cache-Control": "no-store"},
    )


@router.post("/{personnel_id}/lancer")
def lancer_impression(
    personnel_id: int,
    request: Request,
    admin: Utilisateur = Depends(exiger_bureau),
    db: Session = Depends(get_db),
):
    """Impression navigateur : le dialogue système s'ouvre ; pas d'envoi CUPS ici."""
    _personne(db, personnel_id)
    return JSONResponse({"envoye": False, "message": "Ouvrez le dialogue d'impression."})
