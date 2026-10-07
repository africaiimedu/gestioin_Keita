"""Menu cantine : l'étudiant commande, la cuisine prépare."""

from __future__ import annotations

import io
import json
import re

import qrcode
from fastapi import APIRouter, Depends, File, Form, Request, UploadFile
from fastapi.responses import Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import base_url
from app.deps import (
    Redirection,
    exiger_cuisiniere,
    exiger_etudiant,
    get_db,
    maison,
    utilisateur_courant,
)
from app.models import (
    CategoriePlat,
    CommandeCantine,
    Etudiant,
    LigneCommande,
    Plat,
    PointCantine,
    Utilisateur,
)
from app.security import verifier_mot_de_passe
from app.services.limite import autoriser
from app.services.menu_cantine import (
    RefusCommande,
    annuler_commande,
    avancer_statut,
    ajouter_plat,
    catalogue,
    lire_panier,
    modifier_plat,
    passer_commande,
    point_actif,
    poser_image_plat,
    preparer_image_plat,
    prix_saisi,
    retirer_plat,
)
from app.ui import csrf_valide, flash, render

router = APIRouter()
_PIN = re.compile(r"^\d{4}$")
_LIBELLES = {
    "recue": "Reçue",
    "preparation": "En préparation",
    "prete": "Prête",
    "remise": "Remise",
    "annulee": "Annulée",
}


def _etudiant_de(db: Session, utilisateur: Utilisateur) -> Etudiant:
    etudiant = db.get(Etudiant, utilisateur.etudiant_id)
    if etudiant is None:
        raise Redirection("/espace")
    return etudiant


@router.get("/menu")
def menu_principal(request: Request, db: Session = Depends(get_db)):
    utilisateur = utilisateur_courant(request, db)
    if utilisateur is not None and utilisateur.role != "etudiant":
        raise Redirection(maison(utilisateur.role))
    point = point_actif(db)
    if point is None:
        raise Redirection("/login")
    if utilisateur is None:
        raise Redirection(f"/login?suivant=/m/{point.jeton}")
    raise Redirection(f"/m/{point.jeton}")


@router.get("/m/{jeton}")
def menu(
    jeton: str,
    request: Request,
    db: Session = Depends(get_db),
):
    point = point_actif(db, jeton)
    if point is None:
        flash(request, "erreur", "Ce QR code de cantine n'est plus valable.")
        raise Redirection("/login")
    utilisateur = utilisateur_courant(request, db)
    if utilisateur is None:
        raise Redirection(f"/login?suivant=/m/{jeton}")
    if utilisateur.role != "etudiant" or not utilisateur.etudiant_id:
        raise Redirection(maison(utilisateur.role))
    etudiant = _etudiant_de(db, utilisateur)
    commandes = db.scalars(
        select(CommandeCantine)
        .where(CommandeCantine.etudiant_id == etudiant.id)
        .order_by(CommandeCantine.id.desc())
        .limit(8)
    ).all()
    return render(
        request,
        "menu.html",
        user=utilisateur,
        point=point,
        groupes=catalogue(db),
        etudiant=etudiant,
        commandes=commandes,
        apercu=False,
        libelles=_LIBELLES,
    )


@router.post("/m/{jeton}/commander")
def commander(
    jeton: str,
    request: Request,
    panier: str = Form(""),
    cle: str = Form(""),
    pin: str = Form(""),
    csrf: str = Form(""),
    utilisateur: Utilisateur = Depends(exiger_etudiant),
    db: Session = Depends(get_db),
):
    retour = f"/m/{jeton}"
    if not csrf_valide(request, csrf):
        flash(request, "erreur", "Formulaire expiré. Rechargez le menu.")
        raise Redirection(retour)
    point = point_actif(db, jeton)
    if point is None:
        flash(request, "erreur", "Ce QR code de cantine n'est plus valable.")
        raise Redirection("/menu")
    etudiant = _etudiant_de(db, utilisateur)
    try:
        lignes = lire_panier(json.loads(panier))
    except (json.JSONDecodeError, RefusCommande) as exc:
        flash(request, "erreur", str(exc) if isinstance(exc, RefusCommande) else "Le panier est illisible.")
        raise Redirection(retour) from exc
    pin_nouveau = None
    if utilisateur.pin_cantine_hash:
        if not autoriser(f"pin-cantine:{utilisateur.id}", 5, 600):
            flash(request, "erreur", "Trop de codes incorrects. Réessayez dans quelques minutes.")
            raise Redirection(retour)
        if not verifier_mot_de_passe(pin, utilisateur.pin_cantine_hash):
            flash(request, "erreur", "Code cantine incorrect.")
            raise Redirection(retour)
    else:
        if not _PIN.match(pin or ""):
            flash(request, "erreur", "Choisissez un code cantine à 4 chiffres.")
            raise Redirection(retour)
        pin_nouveau = pin
    try:
        commande, _nouvelle = passer_commande(
            db, etudiant, utilisateur, point, lignes, cle, pin_nouveau
        )
    except RefusCommande as exc:
        flash(request, "erreur", str(exc))
        raise Redirection(retour) from exc
    raise Redirection(f"/menu/commande/{commande.id}")


@router.get("/menu/commande/{commande_id}")
def recu(
    commande_id: int,
    request: Request,
    utilisateur: Utilisateur = Depends(exiger_etudiant),
    db: Session = Depends(get_db),
):
    etudiant = _etudiant_de(db, utilisateur)
    commande = db.get(CommandeCantine, commande_id)
    if commande is None or commande.etudiant_id != etudiant.id:
        raise Redirection("/menu")
    lignes = db.scalars(select(LigneCommande).where(LigneCommande.commande_id == commande.id)).all()
    return render(
        request,
        "menu_succes.html",
        user=utilisateur,
        etudiant=etudiant,
        commande=commande,
        lignes=lignes,
        libelle=_LIBELLES.get(commande.statut, commande.statut),
    )


@router.post("/menu/commande/{commande_id}/annuler")
def annuler(
    commande_id: int,
    request: Request,
    csrf: str = Form(""),
    utilisateur: Utilisateur = Depends(exiger_etudiant),
    db: Session = Depends(get_db),
):
    if not csrf_valide(request, csrf):
        flash(request, "erreur", "Formulaire expiré. Rechargez la page.")
        raise Redirection(f"/menu/commande/{commande_id}")
    etudiant = _etudiant_de(db, utilisateur)
    commande = db.get(CommandeCantine, commande_id)
    if commande is None or commande.etudiant_id != etudiant.id:
        raise Redirection("/menu")
    try:
        annuler_commande(db, commande, etudiant)
    except RefusCommande as exc:
        flash(request, "erreur", str(exc))
    else:
        flash(request, "ok", "Commande annulée. L'argent est revenu sur votre compte.")
    raise Redirection(f"/menu/commande/{commande_id}")


@router.get("/cantine/commandes")
def cuisine(
    request: Request,
    cuisiniere: Utilisateur = Depends(exiger_cuisiniere),
    db: Session = Depends(get_db),
):
    return render(request, "cantine_commandes.html", user=cuisiniere, **_tableau(db))


@router.get("/cantine/commandes.json")
def cuisine_json(
    cuisiniere: Utilisateur = Depends(exiger_cuisiniere),
    db: Session = Depends(get_db),
):
    commandes, plats = _tableau(db).values()
    return {
        "commandes": commandes,
        "plats": [{"id": plat.id, "nom": plat.nom, "disponible": plat.disponible} for plat in plats],
    }


def _tableau(db: Session) -> dict:
    lignes = db.execute(
        select(CommandeCantine, Etudiant)
        .join(Etudiant, Etudiant.id == CommandeCantine.etudiant_id)
        .where(CommandeCantine.statut.notin_(["remise", "annulee"]))
        .order_by(CommandeCantine.id)
    ).all()
    details = []
    for commande, etudiant in lignes:
        articles = db.scalars(select(LigneCommande).where(LigneCommande.commande_id == commande.id)).all()
        details.append(
            {
                "id": commande.id,
                "numero": commande.numero,
                "nom": f"{etudiant.prenom} {etudiant.nom}",
                "matricule": etudiant.matricule,
                "statut": commande.statut,
                "libelle": _LIBELLES.get(commande.statut, commande.statut),
                "montant": commande.montant,
                "articles": [f"{ligne.quantite} × {ligne.nom}" for ligne in articles],
            }
        )
    plats = db.scalars(select(Plat).order_by(Plat.nom)).all()
    return {"commandes": details, "plats": plats}


@router.post("/cantine/commandes/{commande_id}")
def cuisine_avancer(
    commande_id: int,
    request: Request,
    csrf: str = Form(""),
    cuisiniere: Utilisateur = Depends(exiger_cuisiniere),
    db: Session = Depends(get_db),
):
    if not csrf_valide(request, csrf):
        flash(request, "erreur", "Formulaire expiré. Rechargez la page.")
        raise Redirection("/cantine/commandes")
    commande = db.get(CommandeCantine, commande_id)
    if commande is None:
        raise Redirection("/cantine/commandes")
    try:
        avancer_statut(db, commande, cuisiniere.id)
    except RefusCommande as exc:
        flash(request, "erreur", str(exc))
    raise Redirection("/cantine/commandes")


@router.post("/cantine/plats/{plat_id}/epuise")
def epuiser(
    plat_id: int,
    request: Request,
    csrf: str = Form(""),
    cuisiniere: Utilisateur = Depends(exiger_cuisiniere),
    db: Session = Depends(get_db),
):
    if not csrf_valide(request, csrf):
        flash(request, "erreur", "Formulaire expiré. Rechargez la page.")
        raise Redirection("/cantine/commandes")
    plat = db.get(Plat, plat_id)
    if plat is not None:
        plat.disponible = not plat.disponible
        if plat.disponible and plat.stock == 0:
            plat.stock = None
        db.commit()
    raise Redirection("/cantine/commandes")


def _image_recue(fichier: UploadFile | None) -> bytes | None:
    if fichier is None or not fichier.filename:
        return None
    return preparer_image_plat(fichier.file.read())


@router.get("/cantine/menu")
def gerer_menu(
    request: Request,
    ajout: str = "",
    plat: str = "",
    cuisiniere: Utilisateur = Depends(exiger_cuisiniere),
    db: Session = Depends(get_db),
):
    categories = db.scalars(select(CategoriePlat).order_by(CategoriePlat.ordre, CategoriePlat.id)).all()
    choisi = db.get(Plat, int(plat)) if plat.isdigit() else None
    return render(
        request,
        "cantine_menu.html",
        user=cuisiniere,
        groupes=catalogue(db),
        categories=categories,
        choisi=choisi,
        ajout=ajout == "1" and choisi is None,
    )


@router.post("/cantine/menu")
def creer_plat(
    request: Request,
    nom: str = Form(""),
    description: str = Form(""),
    prix: str = Form(""),
    categorie_id: str = Form(""),
    csrf: str = Form(""),
    image: UploadFile | None = File(None),
    cuisiniere: Utilisateur = Depends(exiger_cuisiniere),
    db: Session = Depends(get_db),
):
    if not csrf_valide(request, csrf):
        flash(request, "erreur", "Formulaire expiré. Rechargez la page.")
        raise Redirection("/cantine/menu")
    try:
        jpeg = _image_recue(image)
        cree = ajouter_plat(db, nom, description, prix_saisi(prix), int(categorie_id))
        if jpeg:
            poser_image_plat(db, cree, jpeg)
    except (RefusCommande, ValueError) as exc:
        flash(request, "erreur", str(exc) if isinstance(exc, RefusCommande) else "Choisissez une catégorie.")
        raise Redirection("/cantine/menu?ajout=1") from exc
    flash(request, "ok", "Plat ajouté. Le QR code de la cantine reste le même.")
    raise Redirection(f"/cantine/menu?plat={cree.id}")


@router.post("/cantine/plats/{plat_id}")
def changer_plat(
    plat_id: int,
    request: Request,
    nom: str = Form(""),
    description: str = Form(""),
    prix: str = Form(""),
    categorie_id: str = Form(""),
    disponible: str = Form(""),
    csrf: str = Form(""),
    image: UploadFile | None = File(None),
    cuisiniere: Utilisateur = Depends(exiger_cuisiniere),
    db: Session = Depends(get_db),
):
    if not csrf_valide(request, csrf):
        flash(request, "erreur", "Formulaire expiré. Rechargez la page.")
        raise Redirection(f"/cantine/menu?plat={plat_id}")
    try:
        jpeg = _image_recue(image)
        plat = modifier_plat(
            db,
            plat_id,
            nom,
            description,
            prix_saisi(prix),
            int(categorie_id),
            disponible == "1",
        )
        if jpeg:
            poser_image_plat(db, plat, jpeg)
    except (RefusCommande, ValueError) as exc:
        flash(request, "erreur", str(exc) if isinstance(exc, RefusCommande) else "Ce plat n'est plus dans le menu.")
    else:
        flash(request, "ok", "Menu mis à jour. Le QR code affiche déjà ce changement.")
    raise Redirection(f"/cantine/menu?plat={plat_id}")


@router.post("/cantine/plats/{plat_id}/retirer")
def supprimer_plat(
    plat_id: int,
    request: Request,
    csrf: str = Form(""),
    cuisiniere: Utilisateur = Depends(exiger_cuisiniere),
    db: Session = Depends(get_db),
):
    if not csrf_valide(request, csrf):
        flash(request, "erreur", "Formulaire expiré. Rechargez la page.")
        raise Redirection("/cantine/menu")
    try:
        nom = retirer_plat(db, plat_id)
    except RefusCommande as exc:
        flash(request, "erreur", str(exc))
    else:
        flash(request, "ok", f"{nom} a été retiré. Le QR code reste le même.")
    raise Redirection("/cantine/menu")


@router.get("/cantine/affiche")
def affiche(
    request: Request,
    cuisiniere: Utilisateur = Depends(exiger_cuisiniere),
    db: Session = Depends(get_db),
):
    point = db.scalar(select(PointCantine).where(PointCantine.actif.is_(True)).order_by(PointCantine.id))
    if point is None:
        flash(request, "erreur", "Aucune cantine n'est ouverte.")
        raise Redirection("/cantine")
    return render(request, "cantine_affiche.html", user=cuisiniere, point=point, url=f"{base_url()}/m/{point.jeton}")


@router.get("/cantine/qr.png")
def qr_cantine(
    cuisiniere: Utilisateur = Depends(exiger_cuisiniere),
    db: Session = Depends(get_db),
):
    point = db.scalar(select(PointCantine).where(PointCantine.actif.is_(True)).order_by(PointCantine.id))
    if point is None:
        return Response(status_code=404)
    image = qrcode.make(f"{base_url()}/m/{point.jeton}")
    tampon = io.BytesIO()
    image.save(tampon, format="PNG")
    return Response(tampon.getvalue(), media_type="image/png")
