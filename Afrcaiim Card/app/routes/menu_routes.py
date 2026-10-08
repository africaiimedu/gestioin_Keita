"""Menu cantine : l'étudiant commande, la cuisine prépare."""

from __future__ import annotations

import io
import json
from datetime import date, timedelta

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
    RecuCantine,
    Utilisateur,
    maintenant,
)
from app.services.comptes import doit_choisir_mot_de_passe
from app.services.menu_cantine import (
    RefusCommande,
    annuler_commande,
    avancer_statut,
    ajouter_plat,
    catalogue,
    encaisser_commande,
    lire_panier,
    modifier_plat,
    passer_commande,
    point_actif,
    poser_image_plat,
    preparer_image_plat,
    prix_sans_solde_saisi,
    prix_saisi,
    refuser_commande,
    retirer_plat,
)
from app.services.recus import MODES, NATURES, lister, rapport
from app.ui import csrf_valide, flash, render

router = APIRouter()
_LIBELLES = {
    "a_payer": "À payer à la caisse",
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
    if doit_choisir_mot_de_passe(utilisateur):
        raise Redirection("/compte")
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
    confirme: str = Form(""),
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
    if confirme != "1":
        flash(request, "erreur", "Confirmez la commande avant de la valider.")
        raise Redirection(retour)
    try:
        commande, _nouvelle = passer_commande(db, etudiant, utilisateur, point, lignes, cle)
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
    recu_commande = db.scalar(
        select(RecuCantine).where(RecuCantine.commande_id == commande.id).order_by(RecuCantine.id.desc())
    )
    return render(
        request,
        "menu_succes.html",
        user=utilisateur,
        etudiant=etudiant,
        commande=commande,
        lignes=lignes,
        recu=recu_commande,
        libelle=_LIBELLES.get(commande.statut, commande.statut),
    )


@router.get("/menu/recus")
def mes_recus(
    request: Request,
    utilisateur: Utilisateur = Depends(exiger_etudiant),
    db: Session = Depends(get_db),
):
    etudiant = _etudiant_de(db, utilisateur)
    recus = db.scalars(
        select(RecuCantine).where(RecuCantine.etudiant_id == etudiant.id).order_by(RecuCantine.id.desc()).limit(100)
    ).all()
    return render(
        request,
        "recus_etudiant.html",
        user=utilisateur,
        etudiant=etudiant,
        recus=recus,
        natures=NATURES,
        modes=MODES,
    )


@router.get("/menu/recus/{recu_id}")
def mon_recu(
    recu_id: int,
    request: Request,
    utilisateur: Utilisateur = Depends(exiger_etudiant),
    db: Session = Depends(get_db),
):
    etudiant = _etudiant_de(db, utilisateur)
    recu_vu = db.get(RecuCantine, recu_id)
    if recu_vu is None or recu_vu.etudiant_id != etudiant.id:
        raise Redirection("/menu/recus")
    return _page_recu(request, db, utilisateur, recu_vu, "/menu/recus")


def _page_recu(request: Request, db: Session, utilisateur: Utilisateur, recu_vu: RecuCantine, retour: str):
    agent = db.get(Utilisateur, recu_vu.agent_id) if recu_vu.agent_id else None
    commande = db.get(CommandeCantine, recu_vu.commande_id) if recu_vu.commande_id else None
    lignes = [morceau.strip() for morceau in (recu_vu.details or "").split(" ; ") if morceau.strip()]
    return render(
        request,
        "recu_cantine.html",
        user=utilisateur,
        recu=recu_vu,
        commande=commande,
        lignes=lignes,
        agent=agent,
        natures=NATURES,
        modes=MODES,
        retour=retour,
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
    payee_par_solde = commande.statut == "recue" and commande.mode_paiement == "solde"
    try:
        annuler_commande(db, commande, etudiant)
    except RefusCommande as exc:
        flash(request, "erreur", str(exc))
    else:
        flash(
            request,
            "ok",
            "Commande annulée. L'argent est revenu sur votre compte." if payee_par_solde else "Commande annulée.",
        )
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
        recu_commande = db.scalar(
            select(RecuCantine.id).where(RecuCantine.commande_id == commande.id).order_by(RecuCantine.id.desc())
        )
        details.append(
            {
                "id": commande.id,
                "numero": commande.numero,
                "nom": f"{etudiant.prenom} {etudiant.nom}",
                "matricule": etudiant.matricule,
                "statut": commande.statut,
                "libelle": _LIBELLES.get(commande.statut, commande.statut),
                "montant": commande.montant,
                "mode_paiement": commande.mode_paiement,
                "recu_id": recu_commande,
                "articles": [f"{ligne.quantite} × {ligne.nom}" for ligne in articles],
            }
        )
    plats = db.scalars(select(Plat).order_by(Plat.nom)).all()
    return {"commandes": details, "plats": plats}


@router.post("/cantine/commandes/{commande_id}/encaisser")
def cuisine_encaisser(
    commande_id: int,
    request: Request,
    mode: str = Form(""),
    csrf: str = Form(""),
    cuisiniere: Utilisateur = Depends(exiger_cuisiniere),
    db: Session = Depends(get_db),
):
    if not csrf_valide(request, csrf):
        flash(request, "erreur", "Formulaire expiré. Rechargez la page.")
        raise Redirection("/cantine/commandes")
    try:
        recu_emis = encaisser_commande(db, commande_id, mode, cuisiniere.id)
    except RefusCommande as exc:
        flash(request, "erreur", str(exc))
        raise Redirection("/cantine/commandes") from exc
    flash(request, "ok", f"Paiement reçu : {recu_emis.numero}. La commande passe en cuisine.")
    raise Redirection(f"/cantine/recus/{recu_emis.id}")


@router.post("/cantine/commandes/{commande_id}/refuser")
def cuisine_refuser(
    commande_id: int,
    request: Request,
    csrf: str = Form(""),
    cuisiniere: Utilisateur = Depends(exiger_cuisiniere),
    db: Session = Depends(get_db),
):
    if not csrf_valide(request, csrf):
        flash(request, "erreur", "Formulaire expiré. Rechargez la page.")
        raise Redirection("/cantine/commandes")
    try:
        refuser_commande(db, commande_id, cuisiniere.id)
    except RefusCommande as exc:
        flash(request, "erreur", str(exc))
    else:
        flash(request, "ok", "Commande non payée retirée.")
    raise Redirection("/cantine/commandes")


def _jour(texte: str, defaut: date) -> date:
    try:
        return date.fromisoformat((texte or "").strip())
    except ValueError:
        return defaut


@router.get("/cantine/recus")
def cuisine_recus(
    request: Request,
    jour: str = "",
    cuisiniere: Utilisateur = Depends(exiger_cuisiniere),
    db: Session = Depends(get_db),
):
    choisi = _jour(jour, maintenant().date())
    recus = lister(db, choisi, choisi)
    valides = [ligne for ligne in recus if ligne.annule_le is None]
    return render(
        request,
        "cantine_recus.html",
        user=cuisiniere,
        jour=choisi,
        recus=recus,
        total=sum(ligne.montant for ligne in valides if ligne.nature != "recharge"),
        natures=NATURES,
        modes=MODES,
    )


@router.get("/cantine/recus/{recu_id}")
def cuisine_recu(
    recu_id: int,
    request: Request,
    cuisiniere: Utilisateur = Depends(exiger_cuisiniere),
    db: Session = Depends(get_db),
):
    recu_vu = db.get(RecuCantine, recu_id)
    if recu_vu is None:
        raise Redirection("/cantine/recus")
    return _page_recu(request, db, cuisiniere, recu_vu, f"/cantine/recus?jour={recu_vu.cree_le.date().isoformat()}")


@router.get("/cantine/rapport")
def cuisine_rapport(
    request: Request,
    du: str = "",
    au: str = "",
    cuisiniere: Utilisateur = Depends(exiger_cuisiniere),
    db: Session = Depends(get_db),
):
    aujourdhui = maintenant().date()
    debut = _jour(du, aujourdhui.replace(day=1))
    fin = _jour(au, aujourdhui)
    if fin < debut:
        debut, fin = fin, debut
    if (fin - debut).days > 366:
        debut = fin - timedelta(days=366)
    return render(request, "cantine_rapport.html", user=cuisiniere, r=rapport(db, debut, fin), genere=maintenant())


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
    prix_sans_solde: str = Form(""),
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
        cree = ajouter_plat(
            db, nom, description, prix_saisi(prix), int(categorie_id), prix_sans_solde_saisi(prix_sans_solde),
        )
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
    prix_sans_solde: str = Form(""),
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
            prix_sans_solde_saisi(prix_sans_solde),
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
