"""Pages de la scolarité."""

from __future__ import annotations

import re
import subprocess
import tempfile
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, Response
from sqlalchemy import or_, select
from sqlalchemy.orm import Session, selectinload

from app.config import ROOT, base_url
from app.services.cantine import crediter, prix_repas, regler_prix
from app.services.courrier import formater_francs
from app.deps import Redirection, exiger_admin, exiger_bureau, get_db
from app.models import Etudiant, Journal, MouvementCantine, Utilisateur
from app.services.import_etudiants import analyser_lignes, controler_fiche, lire_tableau
from app.services.metier import (
    carte_courante,
    changer_statut,
    courante_parmi,
    basculer_compte,
    basculer_validation_qr,
    creer_compte_personnel,
    creer_etudiant,
    enregistrer_uid,
    filieres_et_annees,
    journaliser,
    marquer_imprimee,
    matricules_existants,
    modifier_etudiant,
    noter_generation,
    ROLES_PERSONNEL,
    remplacer_photo,
    reediter,
    reinitialiser_mot_de_passe,
)
from app.services.pdf_carte import charger_modele, code_controle, pdf_individuel, pdf_primacy, url_affichee
from app.services.photos import lire_photo, normaliser_photo, photos_depuis_zip
from app.services.statut import libelle_statut, statut_effectif
from app.ui import csrf_valide, flash, render, retour_sur

router = APIRouter(prefix="/admin")


def _exiger_csrf(request: Request, jeton: str, defaut: str) -> None:
    if not csrf_valide(request, jeton):
        flash(request, "erreur", "Formulaire expiré. Rechargez la page et réessayez.")
        raise Redirection(retour_sur(request, defaut))


def _etudiant(db: Session, etudiant_id: int) -> Etudiant:
    etudiant = db.get(Etudiant, etudiant_id)
    if etudiant is None:
        raise Redirection("/admin/etudiants")
    return etudiant


_NOM_IMPRIMANTE = re.compile(
    r"(?:printer|imprimante)\s+(\S+)\s+(?:is|est|disabled|désactivée|desactivee)\b",
    re.IGNORECASE,
)
_URI_IMPRIMANTE = re.compile(r"(\S+)\s*:\s*(\S+://\S+)")


def _etat_imprimante(ligne: str) -> str:
    """Le Mac répond en français ou en anglais. « inactive » veut dire prête, pas arrêtée."""
    texte = ligne.lower()
    if "désactiv" in texte or "desactiv" in texte or "disabled" in texte:
        return "arrêtée"
    if "printing" in texte or "imprime" in texte or "impression" in texte:
        return "en cours"
    return "prête"


def _est_primacy(nom: str, uri: str = "") -> bool:
    texte = f"{nom} {uri}".lower()
    return "primacy" in texte or "evolis" in texte


def _analyser_imprimantes(etat: str, liens: str, noms: str = "") -> list[dict]:
    uris: dict[str, str] = {}
    for ligne in liens.splitlines():
        trouve = _URI_IMPRIMANTE.search(ligne)
        if trouve:
            uris[trouve.group(1)] = trouve.group(2)
    resultat = []
    vus: set[str] = set()
    for ligne in etat.splitlines():
        trouve = _NOM_IMPRIMANTE.search(ligne)
        if not trouve:
            continue
        nom = trouve.group(1)
        vus.add(nom)
        uri = uris.get(nom, "")
        resultat.append({
            "nom": nom,
            "etat": _etat_imprimante(ligne),
            "primacy": _est_primacy(nom, uri),
            "uri": uri,
        })
    for ligne in noms.splitlines():
        nom = ligne.strip()
        if not nom or nom in vus:
            continue
        uri = uris.get(nom, "")
        resultat.append({
            "nom": nom,
            "etat": "prête",
            "primacy": _est_primacy(nom, uri),
            "uri": uri,
        })
    return resultat


def _imprimante_primacy() -> str | None:
    """Nom CUPS de la Primacy 2, s'il est installé sur cet ordinateur."""
    for imp in _lister_imprimantes():
        if imp["primacy"]:
            return imp["nom"]
    return None


def _media_cr80() -> str:
    from app.services.pdf_carte import MM, taille_carte

    largeur, hauteur = taille_carte()

    def _fmt(points: float) -> str:
        return f"{points / MM:.1f}".rstrip("0").rstrip(".")

    return f"Custom.{_fmt(largeur)}x{_fmt(hauteur)}mm"


def _lister_imprimantes() -> list[dict]:
    """Toutes les imprimantes que le Mac connaît (CUPS), Primacy comprise."""
    def _lire(*args: str) -> str:
        resultat = subprocess.run(
            ["lpstat", *args],
            capture_output=True, text=True, timeout=5, stdin=subprocess.DEVNULL,
        )
        return resultat.stdout or ""

    try:
        return _analyser_imprimantes(_lire("-p"), _lire("-v"), _lire("-e"))
    except (OSError, subprocess.TimeoutExpired):
        return []


def _choix_pilote(nom: str) -> dict[str, list[str]]:
    """Options réelles du pilote, pour ne lui envoyer que ce qu'il sait faire."""
    try:
        resultat = subprocess.run(
            ["lpoptions", "-p", nom, "-l"],
            capture_output=True, text=True, timeout=5, stdin=subprocess.DEVNULL,
        )
    except (OSError, subprocess.TimeoutExpired):
        return {}
    if resultat.returncode != 0:
        return {}
    options: dict[str, list[str]] = {}
    for ligne in resultat.stdout.splitlines():
        gauche, sep, droite = ligne.partition(":")
        if not sep or "/" not in gauche:
            continue
        cle = gauche.split("/", 1)[0].strip()
        options[cle] = [mot.lstrip("*") for mot in droite.split() if mot.strip()]
    return options


def _orientation_modele() -> str:
    return "portrait" if str(charger_modele().get("orientation") or "paysage") == "portrait" else "paysage"


def _poser_option(commande: list[str], choix: dict[str, list[str]], cle: str, valeur: str) -> None:
    if valeur in choix.get(cle, []):
        commande += ["-o", f"{cle}={valeur}"]


def _commande_lp(
    nom: str, copies: int, duplex: bool, media: str, choix: dict[str, list[str]], orientation: str = "paysage",
) -> list[str]:
    """Même orientation que la carte, couleurs RVB du fichier, sans réduire la page."""
    paysage = orientation != "portrait"
    commande = [
        "lp", "-d", nom, "-n", str(max(1, min(20, copies))),
        "-o", "fit-to-page=false",
        "-o", "print-color-mode=color",
        "-o", "orientation-requested=5" if paysage else "orientation-requested=3",
    ]
    if "Card" in choix.get("PageSize", []):
        commande += ["-o", "PageSize=Card"]
    elif "CR80" in choix.get("PageSize", []):
        commande += ["-o", "PageSize=CR80"]
    else:
        commande += ["-o", f"media={media}"]
    if paysage:
        _poser_option(commande, choix, "Orientation", "LANDSCAPE_CC90")
    else:
        _poser_option(commande, choix, "Orientation", "PORTRAIT")
    if duplex:
        commande += ["-o", "sides=two-sided-long-edge"]
        for cle, valeurs in choix.items():
            if "DuplexNoTumble" in valeurs:
                commande += ["-o", f"{cle}=DuplexNoTumble"]
                break
    else:
        commande += ["-o", "sides=one-sided"]
        for valeur in ("NONE", "None"):
            if valeur in choix.get("Duplex", []):
                commande += ["-o", f"Duplex={valeur}"]
                break
    for cle in ("ColorModel", "ColorMode"):
        valeurs = choix.get(cle, [])
        if "RGB" in valeurs:
            commande += ["-o", f"{cle}=RGB"]
            break
        if "Color" in valeurs:
            commande += ["-o", f"{cle}=Color"]
            break
    # 1200 dpi gonfle le fichier : le travail tarde, puis la Primacy 2 sort une carte vierge.
    for voulu in ("600dpi", "300dpi", "300x300dpi"):
        if voulu in choix.get("Resolution", []):
            commande += ["-o", f"Resolution={voulu}"]
            break
    for cle in ("FColorContrast", "BColorContrast"):
        _poser_option(commande, choix, cle, "VAL16")
    for cle in ("FColorBrightness", "BColorBrightness"):
        _poser_option(commande, choix, cle, "VAL10")
    _poser_option(commande, choix, "GDuplexType", "DUPLEX_CC")
    for cle in ("FHalftoning", "BHalftoning"):
        _poser_option(commande, choix, cle, "DITHERING")
    for cle in ("FBlackManagement", "BBlackManagement"):
        _poser_option(commande, choix, cle, "TEXTINBLACK")
    for cle in ("IFColorProfileMode", "IBColorProfileMode"):
        _poser_option(commande, choix, cle, "DRIVERPROFILE")
    for cle in ("IFColorProfile", "IBColorProfile"):
        _poser_option(commande, choix, cle, "STDPROFILE")
    _poser_option(commande, choix, "GSmoothing", "ADVSMOOTH")
    demi_tour = "ON" if paysage else "OFF"
    for cle in ("FPageRotate180", "BPageRotate180"):
        _poser_option(commande, choix, cle, demi_tour)
    return commande


def _envoyer_vers(pdf: bytes, nom: str, duplex: bool, copies: int, orientation: str | None = None) -> tuple[bool, str]:
    """Envoie le PDF CR80 au pilote choisi, dans le sens demandé, sans le réduire à une page A4."""
    sens = orientation if orientation in ("paysage", "portrait") else _orientation_modele()
    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as tmp:
        tmp.write(pdf)
        chemin = tmp.name
    commande = _commande_lp(nom, copies, duplex, _media_cr80(), _choix_pilote(nom), sens)
    commande.append(chemin)
    try:
        resultat = subprocess.run(
            commande,
            capture_output=True, text=True, timeout=30, stdin=subprocess.DEVNULL,
        )
    except (OSError, subprocess.TimeoutExpired):
        return False, "Le système d'impression du Mac n'a pas répondu."
    finally:
        Path(chemin).unlink(missing_ok=True)
    if resultat.returncode != 0:
        detail = (resultat.stderr or resultat.stdout or "").strip().splitlines()
        return False, (detail[0][:180] if detail else "L'imprimante a refusé le travail.")
    return True, nom


def _envoyer_primacy(pdf: bytes) -> str | None:
    nom = _imprimante_primacy()
    if not nom:
        return None
    ok, nom_ou_message = _envoyer_vers(pdf, nom, duplex=True, copies=1)
    return nom_ou_message if ok else None


def _raison_blocage(etudiant: Etudiant, carte) -> str | None:
    if carte is None:
        return "Cet étudiant n'a pas de carte active."
    effectif = statut_effectif(carte.statut, carte.date_validite)
    if effectif != "active":
        return f"Impression refusée : la carte est « {libelle_statut(effectif)} »."
    if lire_photo(etudiant.photo_chemin) is None:
        return "Ajoutez une photo avant de générer le PDF."
    return None


def _slug(texte: str) -> str:
    import unicodedata

    propre = unicodedata.normalize("NFD", texte)
    propre = "".join(c for c in propre if unicodedata.category(c) != "Mn")
    propre = re.sub(r"[^A-Za-z0-9]+", "-", propre).strip("-")
    return propre or "lot"


def _lot(db: Session, filiere: str, annee: str):
    etudiants = db.scalars(
        select(Etudiant)
        .where(Etudiant.filiere == filiere, Etudiant.annee_academique == annee)
        .options(selectinload(Etudiant.cartes))
        .order_by(Etudiant.nom, Etudiant.prenom)
    ).all()
    inclus = []
    exclus = []
    for etudiant in etudiants:
        carte = courante_parmi(etudiant.cartes)
        raison = _raison_blocage(etudiant, carte)
        if raison:
            exclus.append({"etudiant": etudiant, "raison": raison})
        else:
            inclus.append({"etudiant": etudiant, "carte": carte})
    return inclus, exclus


@router.get("")
def atelier(request: Request, admin: Utilisateur = Depends(exiger_bureau)):
    return render(request, "studio.html", user=admin)


@router.get("/etudiants")
def liste(
    request: Request,
    q: str = "",
    filiere: str = "",
    annee: str = "",
    admin: Utilisateur = Depends(exiger_bureau),
    db: Session = Depends(get_db),
):
    requete = select(Etudiant).options(selectinload(Etudiant.cartes)).order_by(Etudiant.nom, Etudiant.prenom)
    if filiere:
        requete = requete.where(Etudiant.filiere == filiere)
    if annee:
        requete = requete.where(Etudiant.annee_academique == annee)
    if q.strip():
        motif = f"%{q.strip()}%"
        requete = requete.where(
            or_(Etudiant.nom.ilike(motif), Etudiant.prenom.ilike(motif), Etudiant.matricule.ilike(motif))
        )
    lignes = []
    for etudiant in db.scalars(requete).all():
        carte = courante_parmi(etudiant.cartes)
        lignes.append(
            {
                "etudiant": etudiant,
                "carte": carte,
                "statut": statut_effectif(carte.statut, carte.date_validite) if carte else None,
            }
        )
    filieres, annees = filieres_et_annees(db)
    return render(
        request,
        "admin_etudiants.html",
        user=admin,
        lignes=lignes,
        filieres=filieres,
        annees=annees,
        q=q,
        filiere=filiere,
        annee=annee,
    )


@router.post("/etudiants")
async def ajouter(
    request: Request,
    prenom: str = Form(""),
    nom: str = Form(""),
    matricule: str = Form(""),
    filiere: str = Form(""),
    annee_academique: str = Form(""),
    date_validite: str = Form(""),
    sexe: str = Form(""),
    csrf: str = Form(""),
    photo: UploadFile | None = File(None),
    admin: Utilisateur = Depends(exiger_bureau),
    db: Session = Depends(get_db),
):
    _exiger_csrf(request, csrf, "/admin/etudiants")
    try:
        fiche = controler_fiche(
            prenom, nom, matricule, filiere, annee_academique, date_validite or None,
            sexe=sexe, sexe_obligatoire=True,
        )
        jpeg = None
        if photo is not None and photo.filename:
            blob = await photo.read()
            jpeg = normaliser_photo(blob)
        _, secret = creer_etudiant(
            db,
            prenom=fiche.prenom,
            nom=fiche.nom,
            matricule=fiche.matricule,
            filiere=fiche.filiere,
            annee_academique=fiche.annee_academique,
            date_validite=fiche.date_validite,
            jpeg=jpeg,
            sexe=fiche.sexe,
            acteur_id=admin.id,
            action="creee",
        )
    except ValueError as exc:
        flash(request, "erreur", str(exc))
        raise Redirection("/admin/etudiants") from exc
    flash(
        request,
        "ok",
        f"{fiche.prenom} {fiche.nom} {'créée' if fiche.sexe == 'F' else 'créé'}. Mot de passe temporaire : {secret} — copiez-le maintenant, il ne sera plus affiché.",
    )
    raise Redirection("/admin/etudiants")


@router.get("/etudiants/{etudiant_id}")
def detail(
    etudiant_id: int,
    request: Request,
    admin: Utilisateur = Depends(exiger_bureau),
    db: Session = Depends(get_db),
):
    etudiant = db.get(Etudiant, etudiant_id)
    if etudiant is None:
        raise Redirection("/admin/etudiants")
    carte = carte_courante(db, etudiant.id)
    statut = statut_effectif(carte.statut, carte.date_validite) if carte else None
    journaux = db.scalars(
        select(Journal).where(Journal.etudiant_id == etudiant.id).order_by(Journal.cree_le.desc()).limit(20)
    ).all()
    mouvements = db.scalars(
        select(MouvementCantine)
        .where(MouvementCantine.etudiant_id == etudiant.id)
        .order_by(MouvementCantine.id.desc())
        .limit(8)
    ).all()
    return render(
        request,
        "admin_detail.html",
        user=admin,
        etudiant=etudiant,
        carte=carte,
        statut=statut,
        journaux=journaux,
        mouvements=mouvements,
        prix_repas=formater_francs(prix_repas()),
        solde=formater_francs(etudiant.solde_cantine or 0),
    )


@router.post("/etudiants/{etudiant_id}")
def modifier(
    etudiant_id: int,
    request: Request,
    prenom: str = Form(""),
    nom: str = Form(""),
    filiere: str = Form(""),
    annee_academique: str = Form(""),
    date_validite: str = Form(""),
    email: str = Form(""),
    sexe: str = Form(""),
    csrf: str = Form(""),
    admin: Utilisateur = Depends(exiger_bureau),
    db: Session = Depends(get_db),
):
    etudiant = _etudiant(db, etudiant_id)
    _exiger_csrf(request, csrf, f"/admin/etudiants/{etudiant_id}")
    try:
        fiche = controler_fiche(
            prenom, nom, etudiant.matricule, filiere, annee_academique, date_validite or None, email,
            sexe=sexe, sexe_obligatoire=True,
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
            sexe=fiche.sexe,
            acteur_id=admin.id,
        )
    except ValueError as exc:
        flash(request, "erreur", str(exc))
        raise Redirection(f"/admin/etudiants/{etudiant_id}") from exc
    flash(request, "ok", "Fiche enregistrée.")
    raise Redirection(f"/admin/etudiants/{etudiant_id}")


@router.post("/etudiants/{etudiant_id}/cantine")
def crediter_cantine(
    etudiant_id: int,
    request: Request,
    montant: str = Form(""),
    csrf: str = Form(""),
    admin: Utilisateur = Depends(exiger_bureau),
    db: Session = Depends(get_db),
):
    etudiant = _etudiant(db, etudiant_id)
    _exiger_csrf(request, csrf, f"/admin/etudiants/{etudiant_id}")
    try:
        solde = crediter(db, etudiant, int(str(montant).strip()), admin.id)
    except (TypeError, ValueError) as exc:
        texte = str(exc)
        if "invalid literal" in texte or not texte:
            texte = "Indiquez un montant en francs guinéens, sans virgule."
        flash(request, "erreur", texte)
        raise Redirection(f"/admin/etudiants/{etudiant_id}") from exc
    flash(request, "ok", f"Compte crédité. Il reste {formater_francs(solde)}.")
    raise Redirection(f"/admin/etudiants/{etudiant_id}")


@router.post("/cantine/prix")
def changer_prix(
    request: Request,
    montant: str = Form(""),
    csrf: str = Form(""),
    retour: str = Form("/admin"),
    admin: Utilisateur = Depends(exiger_bureau),
    db: Session = Depends(get_db),
):
    if not retour.startswith("/admin/etudiants/"):
        retour = "/admin"
    _exiger_csrf(request, csrf, retour)
    try:
        prix = regler_prix(int(str(montant).strip()))
    except (TypeError, ValueError) as exc:
        texte = str(exc)
        if "invalid literal" in texte or not texte:
            texte = "Indiquez le prix d'un repas en francs guinéens, sans virgule."
        flash(request, "erreur", texte)
        raise Redirection(retour) from exc
    flash(request, "ok", f"Prix d'un repas : {formater_francs(prix)}.")
    raise Redirection(retour)


@router.post("/etudiants/{etudiant_id}/photo")
async def photo(
    etudiant_id: int,
    request: Request,
    csrf: str = Form(""),
    fichier: UploadFile | None = File(None),
    admin: Utilisateur = Depends(exiger_bureau),
    db: Session = Depends(get_db),
):
    etudiant = _etudiant(db, etudiant_id)
    attend_json = "application/json" in request.headers.get("accept", "")
    if attend_json:
        if not csrf_valide(request, csrf or request.headers.get("x-csrf")):
            return JSONResponse({"message": "Formulaire expiré. Rechargez la page."}, status_code=400)
    else:
        _exiger_csrf(request, csrf, f"/admin/etudiants/{etudiant_id}")
    try:
        if fichier is None or not fichier.filename:
            raise ValueError("Choisissez une photo.")
        blob = await fichier.read()
        remplacer_photo(db, etudiant, normaliser_photo(blob), admin.id)
    except ValueError as exc:
        if attend_json:
            return JSONResponse({"message": str(exc)}, status_code=400)
        flash(request, "erreur", str(exc))
        raise Redirection(f"/admin/etudiants/{etudiant_id}") from exc
    if attend_json:
        return {"photo": True}
    flash(request, "ok", "Photo recadrée et enregistrée.")
    raise Redirection(f"/admin/etudiants/{etudiant_id}")


@router.post("/etudiants/{etudiant_id}/statut")
def statut(
    etudiant_id: int,
    request: Request,
    statut: str = Form(""),
    csrf: str = Form(""),
    admin: Utilisateur = Depends(exiger_bureau),
    db: Session = Depends(get_db),
):
    etudiant = _etudiant(db, etudiant_id)
    _exiger_csrf(request, csrf, f"/admin/etudiants/{etudiant_id}")
    carte = carte_courante(db, etudiant.id)
    if carte is None:
        flash(request, "erreur", "Aucune carte à modifier.")
        raise Redirection(f"/admin/etudiants/{etudiant_id}")
    try:
        avertissement = changer_statut(db, carte, statut, admin.id)
    except ValueError as exc:
        flash(request, "erreur", str(exc))
        raise Redirection(f"/admin/etudiants/{etudiant_id}") from exc
    flash(request, "avertissement" if avertissement else "ok", avertissement or "Statut mis à jour.")
    raise Redirection(f"/admin/etudiants/{etudiant_id}")


@router.post("/etudiants/{etudiant_id}/reediter")
def reediter_carte(
    etudiant_id: int,
    request: Request,
    csrf: str = Form(""),
    admin: Utilisateur = Depends(exiger_bureau),
    db: Session = Depends(get_db),
):
    etudiant = _etudiant(db, etudiant_id)
    _exiger_csrf(request, csrf, f"/admin/etudiants/{etudiant_id}")
    reediter(db, etudiant, admin.id)
    flash(request, "ok", "Nouvelle carte créée. L'ancien QR code ne fonctionne plus.")
    raise Redirection(f"/admin/etudiants/{etudiant_id}")


@router.post("/etudiants/{etudiant_id}/reinitialiser")
def reset_mdp(
    etudiant_id: int,
    request: Request,
    csrf: str = Form(""),
    admin: Utilisateur = Depends(exiger_bureau),
    db: Session = Depends(get_db),
):
    etudiant = _etudiant(db, etudiant_id)
    _exiger_csrf(request, csrf, f"/admin/etudiants/{etudiant_id}")
    try:
        secret = reinitialiser_mot_de_passe(db, etudiant)
    except ValueError as exc:
        flash(request, "erreur", str(exc))
        raise Redirection(f"/admin/etudiants/{etudiant_id}") from exc
    flash(request, "ok", f"Nouveau mot de passe temporaire : {secret} — copiez-le maintenant.")
    raise Redirection(f"/admin/etudiants/{etudiant_id}")


@router.post("/etudiants/{etudiant_id}/nfc")
def nfc(
    etudiant_id: int,
    request: Request,
    uid_nfc: str = Form(""),
    csrf: str = Form(""),
    admin: Utilisateur = Depends(exiger_bureau),
    db: Session = Depends(get_db),
):
    from app.config import charger_config

    if not charger_config().get("nfc"):
        raise Redirection(f"/admin/etudiants/{etudiant_id}")
    etudiant = _etudiant(db, etudiant_id)
    _exiger_csrf(request, csrf, f"/admin/etudiants/{etudiant_id}")
    uid = uid_nfc.strip()
    if uid and not re.fullmatch(r"[A-Za-z0-9:-]{4,40}", uid):
        flash(request, "erreur", "L'identifiant de puce contient un caractère non autorisé.")
        raise Redirection(f"/admin/etudiants/{etudiant_id}")
    carte = carte_courante(db, etudiant.id)
    if carte is None:
        flash(request, "erreur", "Aucune carte pour enregistrer la puce.")
        raise Redirection(f"/admin/etudiants/{etudiant_id}")
    enregistrer_uid(db, carte, uid, admin.id)
    flash(request, "ok", "Puce enregistrée.")
    raise Redirection(f"/admin/etudiants/{etudiant_id}")


@router.get("/etudiants/{etudiant_id}/pdf")
def pdf(
    etudiant_id: int,
    request: Request,
    admin: Utilisateur = Depends(exiger_bureau),
    db: Session = Depends(get_db),
):
    etudiant = db.get(Etudiant, etudiant_id)
    if etudiant is None:
        raise Redirection("/admin/etudiants")
    carte = carte_courante(db, etudiant.id)
    raison = _raison_blocage(etudiant, carte)
    if raison:
        flash(request, "erreur", raison)
        raise Redirection(f"/admin/etudiants/{etudiant_id}")
    photo = lire_photo(etudiant.photo_chemin)
    contenu = pdf_individuel(etudiant, photo, carte.jeton, carte.numero_edition, base_url())
    noter_generation(db, carte, admin.id, "PDF individuel")
    return Response(
        contenu,
        media_type="application/pdf",
        headers={
            "Content-Disposition": (
                f'inline; filename="carte-{etudiant.matricule}.pdf"'
                if request.query_params.get("inline")
                else f'attachment; filename="carte-{etudiant.matricule}.pdf"'
            ),
            "Cache-Control": "no-store",
        },
    )


@router.get("/etudiants/{etudiant_id}/imprimer")
def imprimer(etudiant_id: int, admin: Utilisateur = Depends(exiger_bureau)):
    raise Redirection(f"/admin/impression?etudiant={etudiant_id}")


def _format_carte() -> str:
    from app.services.pdf_carte import MM, taille_carte

    largeur, hauteur = taille_carte()

    def _fr(points: float) -> str:
        texte = f"{points / MM:.1f}".rstrip("0").rstrip(".")
        return texte.replace(".", ",")

    return f"CR80 · {_fr(largeur)} × {_fr(hauteur)} mm"


@router.get("/impression")
def page_impression(
    request: Request,
    etudiant: int = 0,
    admin: Utilisateur = Depends(exiger_bureau),
    db: Session = Depends(get_db),
):
    etudiants = db.scalars(select(Etudiant).order_by(Etudiant.nom, Etudiant.prenom)).all()
    choisi = next((ligne for ligne in etudiants if ligne.id == etudiant), None)
    imprimantes = _lister_imprimantes()
    preferee = next((imp["nom"] for imp in imprimantes if imp["primacy"]), "")
    raison = None
    if choisi is not None:
        raison = _raison_blocage(choisi, carte_courante(db, choisi.id))
    return render(
        request,
        "admin_impression.html",
        user=admin,
        etudiants=etudiants,
        choisi=choisi,
        imprimantes=imprimantes,
        preferee=preferee,
        raison=raison,
        format_carte=_format_carte(),
        duplex=bool(preferee),
        orientation=_orientation_modele(),
    )


@router.post("/impression")
def lancer_page_impression(
    request: Request,
    etudiant_id: int = Form(...),
    imprimante: str = Form(...),
    copies: int = Form(1),
    duplex: str | None = Form(None),
    orientation: str = Form("paysage"),
    csrf: str = Form(""),
    admin: Utilisateur = Depends(exiger_bureau),
    db: Session = Depends(get_db),
):
    retour = f"/admin/impression?etudiant={etudiant_id}"
    _exiger_csrf(request, csrf, retour)
    etudiant = db.get(Etudiant, etudiant_id)
    if etudiant is None:
        flash(request, "erreur", "Cet étudiant n'existe pas.")
        raise Redirection("/admin/impression")
    carte = carte_courante(db, etudiant.id)
    raison = _raison_blocage(etudiant, carte)
    if raison:
        flash(request, "erreur", raison)
        raise Redirection(retour)
    connues = {imp["nom"] for imp in _lister_imprimantes()}
    if imprimante not in connues:
        flash(request, "erreur", "Cette imprimante n'est pas installée sur ce Mac.")
        raise Redirection(retour)
    if copies < 1 or copies > 20:
        flash(request, "erreur", "Le nombre de copies doit être entre 1 et 20.")
        raise Redirection(retour)
    recto_verso = duplex == "1"
    sens = "portrait" if orientation == "portrait" else "paysage"
    photo = lire_photo(etudiant.photo_chemin)
    contenu = pdf_individuel(
        etudiant, photo, carte.jeton, carte.numero_edition, base_url(),
        recto_verso, retourner_verso=False,
    )
    ok, detail = _envoyer_vers(contenu, imprimante, recto_verso, copies, sens)
    if not ok:
        flash(request, "erreur", detail)
        raise Redirection(retour)
    face = "recto-verso, bord long" if recto_verso else "recto seul"
    libelle_sens = "portrait" if sens == "portrait" else "paysage"
    marquer_imprimee(db, carte, admin.id, f"{imprimante} · {copies} copie(s) · {face} · {libelle_sens}")
    flash(request, "ok", f"Carte envoyée à {imprimante} ({face}, {libelle_sens}, {_format_carte()}, 100 %).")
    raise Redirection(retour)


@router.post("/etudiants/{etudiant_id}/lancer")
def lancer_impression(
    etudiant_id: int,
    request: Request,
    admin: Utilisateur = Depends(exiger_bureau),
    db: Session = Depends(get_db),
):
    if not csrf_valide(request, request.headers.get("x-csrf")):
        return JSONResponse({"envoye": False, "message": "Session expirée. Rechargez la page."}, status_code=400)
    etudiant = db.get(Etudiant, etudiant_id)
    if etudiant is None:
        return JSONResponse({"envoye": False}, status_code=404)
    carte = carte_courante(db, etudiant.id)
    if _raison_blocage(etudiant, carte):
        return JSONResponse({"envoye": False}, status_code=400)
    photo = lire_photo(etudiant.photo_chemin)
    contenu = pdf_individuel(
        etudiant, photo, carte.jeton, carte.numero_edition, base_url(),
        True, retourner_verso=False,
    )
    nom = _envoyer_primacy(contenu)
    if nom:
        marquer_imprimee(db, carte, admin.id, f"Envoyée à {nom}")
        return {"envoye": True, "imprimante": nom}
    return {"envoye": False}


def _teinte(valeur: str, defaut: str) -> str:
    propre = re.sub(r"[^0-9A-Fa-f]", "", valeur or "")
    if len(propre) != 6:
        return defaut
    return f"#{propre}"


@router.get("/etudiants/{etudiant_id}/qr.png")
def qr_admin(
    etudiant_id: int,
    contenu: str = "securise",
    encre: str = "111111",
    fond: str = "FFFFFF",
    admin: Utilisateur = Depends(exiger_bureau),
    db: Session = Depends(get_db),
):
    from app.config import base_url
    from app.services.pdf_carte import _charge_qr, image_qr

    etudiant = db.get(Etudiant, etudiant_id)
    carte = carte_courante(db, etudiant.id) if etudiant else None
    if etudiant is None or carte is None:
        return Response(status_code=404)
    if contenu not in {"securise", "nom", "prenom", "matricule", "filiere", "ecole", "email", "annee_academique", "date_validite", "url", "edition", "controle"}:
        contenu = "securise"
    png = image_qr(
        _charge_qr({"contenu": contenu}, etudiant, carte.jeton, carte.numero_edition, base_url()),
        _teinte(encre, "#111111"),
        _teinte(fond, "#FFFFFF"),
    )
    return Response(png, media_type="image/png", headers={"Cache-Control": "private, no-store"})


@router.get("/etudiants/{etudiant_id}/code128.png")
def code128_admin(
    etudiant_id: int,
    champ: str = "matricule",
    encre: str = "111111",
    fond: str = "FFFFFF",
    admin: Utilisateur = Depends(exiger_bureau),
    db: Session = Depends(get_db),
):
    from app.config import base_url
    from app.services.pdf_carte import code_controle, image_code128, url_affichee

    etudiant = db.get(Etudiant, etudiant_id)
    carte = carte_courante(db, etudiant.id) if etudiant else None
    if etudiant is None:
        return Response(status_code=404)
    valeurs = {
        "nom": etudiant.nom,
        "prenom": etudiant.prenom,
        "matricule": etudiant.matricule,
        "filiere": etudiant.filiere,
        "ecole": etudiant.filiere,
        "email": etudiant.email or "",
        "annee_academique": etudiant.annee_academique,
        "date_validite": etudiant.date_validite.strftime("%d/%m/%Y"),
        "url": url_affichee(base_url(), etudiant.matricule),
        "edition": f"Éd. {carte.numero_edition if carte else 1}",
        "controle": code_controle(carte.jeton) if carte else "",
    }
    png = image_code128(valeurs.get(champ, etudiant.matricule), _teinte(encre, "#111111"), _teinte(fond, "#FFFFFF"))
    return Response(png, media_type="image/png", headers={"Cache-Control": "private, no-store"})


@router.post("/etudiants/{etudiant_id}/imprimee")
def imprimee(
    etudiant_id: int,
    request: Request,
    csrf: str = Form(""),
    admin: Utilisateur = Depends(exiger_bureau),
    db: Session = Depends(get_db),
):
    etudiant = _etudiant(db, etudiant_id)
    _exiger_csrf(request, csrf, f"/admin/etudiants/{etudiant_id}")
    carte = carte_courante(db, etudiant.id)
    if carte is None:
        flash(request, "erreur", "Aucune carte à marquer.")
        raise Redirection(f"/admin/etudiants/{etudiant_id}")
    marquer_imprimee(db, carte, admin.id, "Marquée imprimée une par une")
    flash(request, "ok", "Carte marquée comme imprimée dans le journal.")
    raise Redirection(f"/admin/etudiants/{etudiant_id}")


@router.get("/etudiants/{etudiant_id}/photo")
def miniature(
    etudiant_id: int,
    admin: Utilisateur = Depends(exiger_bureau),
    db: Session = Depends(get_db),
):
    etudiant = db.get(Etudiant, etudiant_id)
    if etudiant is None:
        return Response(status_code=404)
    photo = lire_photo(etudiant.photo_chemin)
    if photo is None:
        return Response(status_code=404)
    return Response(photo, media_type="image/jpeg", headers={"Cache-Control": "private, no-store"})


@router.get("/lot")
def lot_page(
    request: Request,
    filiere: str = "",
    annee: str = "",
    admin: Utilisateur = Depends(exiger_bureau),
    db: Session = Depends(get_db),
):
    filieres, annees = filieres_et_annees(db)
    inclus, exclus = ([], [])
    if filiere and annee:
        inclus, exclus = _lot(db, filiere, annee)
    return render(
        request,
        "admin_lot.html",
        user=admin,
        filieres=filieres,
        annees=annees,
        filiere=filiere,
        annee=annee,
        inclus=inclus,
        exclus=exclus,
    )


@router.get("/lot/apercu")
def lot_apercu(
    request: Request,
    filiere: str = "",
    annee: str = "",
    admin: Utilisateur = Depends(exiger_bureau),
    db: Session = Depends(get_db),
):
    if not filiere or not annee:
        flash(request, "erreur", "Choisissez une école et une année.")
        raise Redirection("/admin/lot")
    inclus, exclus = _lot(db, filiere, annee)
    cartes = []
    for ligne in inclus:
        etudiant = ligne["etudiant"]
        carte = ligne["carte"]
        cartes.append({
            "nom": etudiant.nom,
            "prenom": etudiant.prenom,
            "matricule": etudiant.matricule,
            "filiere": etudiant.filiere,
            "email": etudiant.email or "",
            "sexe": etudiant.sexe if etudiant.sexe in {"M", "F"} else "M",
            "annee_academique": etudiant.annee_academique,
            "date_validite": etudiant.date_validite.isoformat(),
            "url": url_affichee(base_url(), etudiant.matricule),
            "edition": carte.numero_edition,
            "controle": code_controle(carte.jeton),
            "photo": bool(etudiant.photo_chemin),
            "urls": {
                "photo": f"/admin/etudiants/{etudiant.id}/photo",
                "qr": f"/admin/etudiants/{etudiant.id}/qr.png",
                "barre": f"/admin/etudiants/{etudiant.id}/code128.png",
            },
        })
    donnees = {
        "filiere": filiere,
        "annee": annee,
        "modele": charger_modele(),
        "cartes": cartes,
        "exclus": [
            {"nom": ligne["etudiant"].nom, "prenom": ligne["etudiant"].prenom, "raison": ligne["raison"]}
            for ligne in exclus
        ],
    }
    return render(request, "lot_apercu.html", user=admin, donnees=donnees)


@router.get("/lot.pdf")
def lot_pdf(
    request: Request,
    filiere: str = "",
    annee: str = "",
    admin: Utilisateur = Depends(exiger_bureau),
    db: Session = Depends(get_db),
):
    if not filiere or not annee:
        flash(request, "erreur", "Choisissez une filière et une année.")
        raise Redirection("/admin/lot")
    inclus, _exclus = _lot(db, filiere, annee)
    if not inclus:
        flash(request, "erreur", "Aucune carte imprimable pour ce choix (photo ou statut).")
        raise Redirection(f"/admin/lot?filiere={filiere}&annee={annee}")
    elements = []
    for ligne in inclus:
        photo = lire_photo(ligne["etudiant"].photo_chemin)
        carte = ligne["carte"]
        elements.append((ligne["etudiant"], photo, carte.jeton, carte.numero_edition))
    titre = f"{filiere} {annee}"
    try:
        contenu = pdf_primacy(elements, base_url(), titre)
    except ValueError as exc:
        flash(request, "erreur", str(exc))
        raise Redirection("/admin/lot") from exc
    for ligne in inclus:
        journaliser(
            db,
            "generee",
            utilisateur_id=admin.id,
            etudiant_id=ligne["etudiant"].id,
            carte_id=ligne["carte"].id,
            details=f"Lot {titre}",
        )
    db.commit()
    return Response(
        contenu,
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'attachment; filename="lot-{_slug(filiere)}-{annee}.pdf"',
            "Cache-Control": "no-store",
        },
    )


@router.post("/lot/imprime")
def lot_imprime(
    request: Request,
    filiere: str = Form(""),
    annee: str = Form(""),
    csrf: str = Form(""),
    admin: Utilisateur = Depends(exiger_bureau),
    db: Session = Depends(get_db),
):
    _exiger_csrf(request, csrf, "/admin/lot")
    inclus, _exclus = _lot(db, filiere, annee)
    for ligne in inclus:
        marquer_imprimee(db, ligne["carte"], admin.id, f"Lot imprimé {filiere} {annee}")
    flash(request, "ok", f"{len(inclus)} carte(s) marquée(s) comme imprimées.")
    raise Redirection(f"/admin/lot?filiere={filiere}&annee={annee}")


@router.get("/import")
def import_page(request: Request, admin: Utilisateur = Depends(exiger_bureau)):
    return render(request, "admin_import.html", user=admin, rapport=None)


@router.get("/import/exemple.csv")
def exemple_csv(admin: Utilisateur = Depends(exiger_bureau)):
    return FileResponse(
        ROOT / "exemples" / "import-demonstration.csv",
        filename="import-demonstration.csv",
        media_type="text/csv",
    )


@router.get("/import/valides.csv")
def valides_csv(admin: Utilisateur = Depends(exiger_bureau)):
    return FileResponse(
        ROOT / "exemples" / "etudiants-valides.csv",
        filename="etudiants-valides.csv",
        media_type="text/csv",
    )


@router.post("/import")
async def importer(
    request: Request,
    csrf: str = Form(""),
    tableau: UploadFile | None = File(None),
    photos: UploadFile | None = File(None),
    admin: Utilisateur = Depends(exiger_bureau),
    db: Session = Depends(get_db),
):
    _exiger_csrf(request, csrf, "/admin/import")
    erreurs: list[str] = []
    avertissements: list[str] = []
    crees: list[dict] = []
    if tableau is None or not tableau.filename:
        erreurs.append("Choisissez un fichier CSV ou Excel.")
    else:
        contenu = await tableau.read()
        try:
            lignes = lire_tableau(contenu, tableau.filename)
            pretes, erreurs, avertissements = analyser_lignes(lignes, matricules_existants(db))
        except ValueError as exc:
            erreurs = [str(exc)]
            pretes = []
        zip_photos: dict[str, bytes] = {}
        if photos is not None and photos.filename:
            try:
                zip_photos = photos_depuis_zip(await photos.read())
            except ValueError as exc:
                erreurs.append(str(exc))
                pretes = []
        for ligne, fiche in pretes:
            cle_photo = Path(ligne.valeurs.get("photo") or "").stem.upper()
            blob = zip_photos.get(fiche.matricule) or (zip_photos.get(cle_photo) if cle_photo else None)
            jpeg = None
            if blob:
                try:
                    jpeg = normaliser_photo(blob)
                except ValueError as exc:
                    avertissements.append(f"{fiche.matricule} : {exc}")
            else:
                avertissements.append(
                    f"{fiche.matricule} : photo manquante, la carte ne pourra pas être imprimée."
                )
            try:
                _, secret = creer_etudiant(
                    db,
                    prenom=fiche.prenom,
                    nom=fiche.nom,
                    matricule=fiche.matricule,
                    filiere=fiche.filiere,
                    annee_academique=fiche.annee_academique,
                    date_validite=fiche.date_validite,
                    email=fiche.email,
                    sexe=fiche.sexe or "M",
                    jpeg=jpeg,
                    acteur_id=admin.id,
                    action="importee",
                    details=f"Import ligne {ligne.numero}",
                )
                crees.append({"nom": f"{fiche.prenom} {fiche.nom}", "matricule": fiche.matricule, "mot_de_passe": secret})
            except ValueError as exc:
                erreurs.append(f"Ligne {ligne.numero} : {exc}")
    rapport = {"crees": crees, "erreurs": erreurs, "avertissements": avertissements}
    return render(request, "admin_import.html", user=admin, rapport=rapport)


@router.get("/journal")
def journal(request: Request, admin: Utilisateur = Depends(exiger_bureau), db: Session = Depends(get_db)):
    lignes = db.execute(
        select(Journal, Utilisateur.identifiant, Etudiant.matricule)
        .join(Utilisateur, Journal.utilisateur_id == Utilisateur.id, isouter=True)
        .join(Etudiant, Journal.etudiant_id == Etudiant.id, isouter=True)
        .order_by(Journal.cree_le.desc())
        .limit(300)
    ).all()
    return render(request, "admin_journal.html", user=admin, lignes=lignes)


@router.get("/comptes")
def comptes(request: Request, admin: Utilisateur = Depends(exiger_admin), db: Session = Depends(get_db)):
    codes = [code for code, _libelle in ROLES_PERSONNEL]
    liste = db.scalars(
        select(Utilisateur).where(Utilisateur.role.in_(codes)).order_by(Utilisateur.role, Utilisateur.identifiant)
    ).all()
    return render(request, "admin_comptes.html", user=admin, comptes=liste, roles=ROLES_PERSONNEL)


@router.post("/comptes")
def creer_compte(
    request: Request,
    identifiant: str = Form(""),
    mot_de_passe: str = Form(""),
    confirmation: str = Form(""),
    role: str = Form(""),
    peut_valider_qr: str = Form(""),
    csrf: str = Form(""),
    admin: Utilisateur = Depends(exiger_admin),
    db: Session = Depends(get_db),
):
    _exiger_csrf(request, csrf, "/admin/comptes")
    try:
        compte = creer_compte_personnel(
            db,
            identifiant,
            mot_de_passe,
            confirmation,
            role,
            admin.id,
            peut_valider_qr == "1",
        )
    except ValueError as exc:
        flash(request, "erreur", str(exc))
        raise Redirection("/admin/comptes")
    flash(
        request,
        "ok",
        f"Compte {compte.identifiant} créé. Donnez l'identifiant et le mot de passe à la personne : "
        "elle devra le changer à la première connexion.",
    )
    raise Redirection("/admin/comptes")


@router.post("/comptes/{compte_id}/actif")
def changer_activite_compte(
    compte_id: int,
    request: Request,
    csrf: str = Form(""),
    admin: Utilisateur = Depends(exiger_admin),
    db: Session = Depends(get_db),
):
    _exiger_csrf(request, csrf, "/admin/comptes")
    try:
        compte = basculer_compte(db, compte_id, admin.id)
    except ValueError as exc:
        flash(request, "erreur", str(exc))
        raise Redirection("/admin/comptes")
    etat = "réactivé" if compte.actif else "désactivé"
    flash(request, "ok", f"Le compte {compte.identifiant} est {etat}.")
    raise Redirection("/admin/comptes")


@router.post("/comptes/{compte_id}/qr")
def changer_validation_qr(
    compte_id: int,
    request: Request,
    csrf: str = Form(""),
    admin: Utilisateur = Depends(exiger_admin),
    db: Session = Depends(get_db),
):
    _exiger_csrf(request, csrf, "/admin/comptes")
    try:
        compte = basculer_validation_qr(db, compte_id, admin.id)
    except ValueError as exc:
        flash(request, "erreur", str(exc))
        raise Redirection("/admin/comptes")
    etat = "autorisée" if compte.peut_valider_qr else "retirée"
    flash(request, "ok", f"Validation des QR codes {etat} pour {compte.identifiant}.")
    raise Redirection("/admin/comptes")
