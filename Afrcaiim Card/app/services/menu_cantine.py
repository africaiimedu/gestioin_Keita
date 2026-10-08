"""Menu du jour et débit atomique d'une commande."""

from __future__ import annotations

import re
import unicodedata
from datetime import timedelta

from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError

from app.models import (
    CategoriePlat,
    CommandeCantine,
    Etudiant,
    LigneCommande,
    MouvementCantine,
    Plat,
    PointCantine,
    RecuCantine,
    Utilisateur,
    maintenant,
)
from app.security import hash_mot_de_passe
from app.services.courrier import expedier_debit, formater_francs
from app.services.metier import carte_courante, journaliser
from app.services.recus import MODES, MODES_CAISSE, annuler_recus_commande, details_lignes, emettre_recu
from app.services.statut import statut_effectif

_CLE = re.compile(r"^[A-Za-z0-9_-]{16,64}$")
_STATUTS = ("a_payer", "recue", "preparation", "prete", "remise", "annulee")
_SUIVANT = {"recue": "preparation", "preparation": "prete", "prete": "remise"}


class RefusCommande(ValueError):
    pass


def point_actif(db, jeton: str | None = None) -> PointCantine | None:
    if jeton:
        return db.scalar(
            select(PointCantine).where(PointCantine.jeton == jeton, PointCantine.actif.is_(True))
        )
    return db.scalar(select(PointCantine).where(PointCantine.actif.is_(True)).order_by(PointCantine.id))


_PHOTOS = {
    "thieboudienne": "thieb.jpg",
    "poulet yassa": "yassa.jpg",
    "riz sauce arachide": "arachide.jpg",
    "mafe": "mafe.jpg",
    "brochettes de boeuf": "brochette.jpg",
    "poisson braise": "poisson.jpg",
    "attieke poisson": "attieke.jpg",
    "alloco": "alloco.jpg",
    "fataya": "fataya.jpg",
    "salade d'avocat": "avocat.jpg",
    "thiakry": "thiakry.jpg",
    "beignets": "beignet.jpg",
    "jus de bissap": "bissap.jpg",
    "jus de gingembre": "gingembre.jpg",
    "formule yassa + bissap": "formule.jpg",
}
_SECOURS = {
    "bol": "plat.jpg",
    "grill": "brochette.jpg",
    "frit": "alloco.jpg",
    "feuille": "avocat.jpg",
    "creme": "thiakry.jpg",
    "verre": "bissap.jpg",
}


def image_plat(plat) -> str:
    chemin = getattr(plat, "photo_chemin", None) or ""
    if chemin.startswith("perso/") and chemin.endswith(".jpg") and ".." not in chemin:
        return f"/static/plats/{chemin}"
    brut = unicodedata.normalize("NFKD", plat.nom or "")
    nom = "".join(c for c in brut if not unicodedata.combining(c)).lower().strip()
    fichier = _PHOTOS.get(nom) or _SECOURS.get(getattr(plat, "visuel", ""), "plat.jpg")
    return f"/static/plats/{fichier}"


def catalogue(db) -> list[dict]:
    plats = db.scalars(select(Plat).order_by(Plat.ordre, Plat.id)).all()
    categories = db.scalars(select(CategoriePlat).order_by(CategoriePlat.ordre, CategoriePlat.id)).all()
    par_cat: dict[int, list] = {}
    for plat in plats:
        par_cat.setdefault(plat.categorie_id, []).append(plat)
    return [{"categorie": cat, "plats": par_cat.get(cat.id, [])} for cat in categories if par_cat.get(cat.id)]


QTE_MAX = 10


def lire_panier(brut: list) -> list[tuple[int, int]]:
    if not isinstance(brut, list) or not brut or len(brut) > 8:
        raise RefusCommande("Le panier doit contenir entre 1 et 8 plats.")
    lignes = []
    vus = set()
    for item in brut:
        if not isinstance(item, dict):
            raise RefusCommande("Le panier est illisible.")
        try:
            plat_id = int(item.get("id"))
            quantite = int(item.get("qte"))
        except (TypeError, ValueError):
            raise RefusCommande("Une quantité n'est pas un nombre.") from None
        if plat_id in vus:
            raise RefusCommande("Un plat est en double dans le panier.")
        if quantite < 1 or quantite > QTE_MAX:
            raise RefusCommande(f"La quantité d'un plat doit être entre 1 et {QTE_MAX}.")
        vus.add(plat_id)
        lignes.append((plat_id, quantite))
    return lignes


def passer_commande(
    db,
    etudiant: Etudiant,
    utilisateur: Utilisateur,
    point: PointCantine,
    lignes: list[tuple[int, int]],
    cle: str,
    pin_nouveau: str | None = None,
) -> tuple[CommandeCantine, bool]:
    """Débite une seule fois. La même clé réseau renvoie la commande déjà créée."""
    if not _CLE.match(cle or ""):
        raise RefusCommande("La commande n'a pas de clé de sécurité.")
    deja = db.scalar(select(CommandeCantine).where(CommandeCantine.cle == cle))
    if deja is not None:
        if deja.etudiant_id != etudiant.id:
            raise RefusCommande("Cette commande ne vous appartient pas.")
        return deja, False

    verrouille = db.scalar(select(Etudiant).where(Etudiant.id == etudiant.id).with_for_update())
    carte = carte_courante(db, verrouille.id)
    if carte is None or statut_effectif(carte.statut, carte.date_validite) != "active":
        db.rollback()
        raise RefusCommande("Votre carte n'est pas valide. La cantine reste fermée pour ce compte.")
    try:
        prepares = _reserver(db, lignes)
    except RefusCommande:
        db.rollback()
        raise
    solde = int(verrouille.solde_cantine or 0)
    total_solde = sum(prix * qte for _, prix, _, qte, _ in prepares)
    par_solde = solde >= total_solde
    total = total_solde if par_solde else sum(prix * qte for _, _, prix, qte, _ in prepares)
    for plat, _, _, qte, _ in prepares:
        if plat.stock is not None:
            plat.stock -= qte
            if plat.stock <= 0:
                plat.stock = 0
                plat.disponible = False
    if pin_nouveau:
        utilisateur.pin_cantine_hash = hash_mot_de_passe(pin_nouveau)
    if par_solde:
        verrouille.solde_cantine = solde - total
        db.add(
            MouvementCantine(
                etudiant_id=verrouille.id,
                carte_id=carte.id,
                agent_id=utilisateur.id,
                montant=-total,
                solde_apres=verrouille.solde_cantine,
                cree_le=maintenant(),
            )
        )
    commande = CommandeCantine(
        numero=f"T{cle[:10]}",
        etudiant_id=verrouille.id,
        point_id=point.id,
        montant=total,
        statut="recue" if par_solde else "a_payer",
        mode_paiement="solde" if par_solde else "caisse",
        cle=cle,
        cree_le=maintenant(),
    )
    db.add(commande)
    db.flush()
    commande.numero = f"A-{commande.id:03d}"
    ajoutees = []
    for plat, prix_solde, prix_caisse, qte, nom in prepares:
        ligne = LigneCommande(
            commande_id=commande.id,
            plat_id=plat.id,
            nom=nom,
            prix=prix_solde if par_solde else prix_caisse,
            quantite=qte,
        )
        db.add(ligne)
        ajoutees.append(ligne)
    if par_solde:
        emettre_recu(
            db,
            verrouille,
            nature="commande",
            mode="solde",
            montant=total,
            solde_apres=verrouille.solde_cantine,
            commande=commande,
            details=details_lignes(ajoutees),
            agent_id=utilisateur.id,
        )
        suite = f"-{formater_francs(total)} · reste {formater_francs(verrouille.solde_cantine)}"
    else:
        suite = f"{formater_francs(total)} à payer à la caisse (prix sans solde)"
    journaliser(
        db,
        "commande_cantine",
        utilisateur_id=utilisateur.id,
        etudiant_id=verrouille.id,
        carte_id=carte.id,
        details=f"{commande.numero} · {suite}",
    )
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        deja = db.scalar(select(CommandeCantine).where(CommandeCantine.cle == cle))
        if deja is None:
            raise RefusCommande("La commande n'a pas pu être enregistrée. Réessayez.") from None
        return deja, False
    if par_solde and verrouille.email:
        expedier_debit(verrouille.email, verrouille.prenom, verrouille.nom, total, verrouille.solde_cantine)
    return commande, True


def prix_caisse(plat: Plat) -> int:
    """Prix sans solde : celui saisi par la cuisine, sinon le prix normal."""
    return int(plat.prix_sans_solde) if plat.prix_sans_solde else int(plat.prix)


def _reserver(db, lignes: list[tuple[int, int]]) -> list[tuple[Plat, int, int, int, str]]:
    prepares = []
    for plat_id, quantite in lignes:
        plat = db.scalar(select(Plat).where(Plat.id == plat_id).with_for_update())
        if plat is None or not plat.disponible:
            raise RefusCommande("Un plat du panier n'est plus servi.")
        if plat.stock is not None and plat.stock < quantite:
            raise RefusCommande(f"Il ne reste plus assez de {plat.nom}.")
        prepares.append((plat, int(plat.prix), prix_caisse(plat), quantite, plat.nom))
    return prepares


def _rendre_stock(db, commande: CommandeCantine) -> None:
    lignes = db.scalars(select(LigneCommande).where(LigneCommande.commande_id == commande.id)).all()
    for ligne in lignes:
        if ligne.plat_id is None:
            continue
        plat = db.scalar(select(Plat).where(Plat.id == ligne.plat_id).with_for_update())
        if plat is not None and plat.stock is not None:
            plat.stock += ligne.quantite
            plat.disponible = True


def annuler_commande(db, commande: CommandeCantine, etudiant: Etudiant) -> None:
    if commande.statut == "a_payer":
        _rendre_stock(db, commande)
        commande.statut = "annulee"
        journaliser(db, "annulation_cantine", etudiant_id=etudiant.id, details=f"{commande.numero} · non payée")
        db.commit()
        return
    if commande.statut != "recue":
        raise RefusCommande("La cuisine a déjà commencé. Cette commande ne peut plus être annulée.")
    if commande.mode_paiement != "solde":
        raise RefusCommande("Commande payée à la caisse : demandez le remboursement au comptoir.")
    if maintenant() - _conscient(commande.cree_le) > timedelta(minutes=10):
        raise RefusCommande("Le délai de 10 minutes pour annuler est passé.")
    verrouille = db.scalar(select(Etudiant).where(Etudiant.id == etudiant.id).with_for_update())
    _rendre_stock(db, commande)
    verrouille.solde_cantine = int(verrouille.solde_cantine or 0) + commande.montant
    commande.statut = "annulee"
    annuler_recus_commande(db, commande)
    carte = carte_courante(db, verrouille.id)
    db.add(
        MouvementCantine(
            etudiant_id=verrouille.id,
            carte_id=carte.id if carte else None,
            montant=commande.montant,
            solde_apres=verrouille.solde_cantine,
            cree_le=maintenant(),
        )
    )
    journaliser(
        db,
        "annulation_cantine",
        etudiant_id=verrouille.id,
        details=f"{commande.numero} · +{formater_francs(commande.montant)} · reste {formater_francs(verrouille.solde_cantine)}",
    )
    db.commit()


def encaisser_commande(db, commande_id: int, mode: str, agent_id: int) -> RecuCantine:
    """La cuisine reçoit l'argent d'une commande sans solde. Une seule fois, puis la préparation commence."""
    if mode not in MODES_CAISSE:
        raise RefusCommande("Choisissez Espèces ou Orange Money.")
    commande = db.scalar(select(CommandeCantine).where(CommandeCantine.id == commande_id).with_for_update())
    if commande is None:
        raise RefusCommande("Cette commande n'existe plus.")
    if commande.statut != "a_payer":
        deja = db.scalar(
            select(RecuCantine).where(RecuCantine.commande_id == commande.id).order_by(RecuCantine.id.desc())
        )
        if deja is not None and commande.statut != "annulee":
            return deja
        raise RefusCommande("Cette commande n'attend plus de paiement.")
    etudiant = db.get(Etudiant, commande.etudiant_id)
    lignes = db.scalars(select(LigneCommande).where(LigneCommande.commande_id == commande.id)).all()
    commande.statut = "recue"
    recu = emettre_recu(
        db,
        etudiant,
        nature="commande",
        mode=mode,
        montant=commande.montant,
        commande=commande,
        details=details_lignes(lignes),
        agent_id=agent_id,
    )
    journaliser(
        db,
        "encaissement_cantine",
        utilisateur_id=agent_id,
        etudiant_id=etudiant.id,
        details=f"{commande.numero} · {formater_francs(commande.montant)} · {MODES[mode]} · {recu.numero}",
    )
    db.commit()
    return recu


def refuser_commande(db, commande_id: int, agent_id: int) -> None:
    """La cuisine retire une commande jamais payée."""
    commande = db.scalar(select(CommandeCantine).where(CommandeCantine.id == commande_id).with_for_update())
    if commande is None or commande.statut != "a_payer":
        raise RefusCommande("Seule une commande non payée peut être retirée.")
    _rendre_stock(db, commande)
    commande.statut = "annulee"
    journaliser(
        db,
        "annulation_cantine",
        utilisateur_id=agent_id,
        etudiant_id=commande.etudiant_id,
        details=f"{commande.numero} · non payée, retirée par la cuisine",
    )
    db.commit()


def avancer_statut(db, commande: CommandeCantine, utilisateur_id: int) -> str:
    if commande.statut == "a_payer":
        raise RefusCommande("Encaissez d'abord cette commande : l'étudiant n'a pas de solde suffisant.")
    suivant = _SUIVANT.get(commande.statut)
    if suivant is None:
        raise RefusCommande("Cette commande ne change plus d'étape.")
    commande.statut = suivant
    journaliser(
        db,
        "commande_cantine",
        utilisateur_id=utilisateur_id,
        etudiant_id=commande.etudiant_id,
        details=f"{commande.numero} · {suivant}",
    )
    db.commit()
    return suivant


_VISUELS = {
    "chauds": "bol",
    "grill": "grill",
    "entrees": "frit",
    "vert": "feuille",
    "doux": "creme",
    "boire": "verre",
}


def prix_saisi(texte: str) -> int:
    chiffres = re.sub(r"[^\d]", "", texte or "")
    if not chiffres:
        raise RefusCommande("Indiquez le prix en francs guinéens.")
    prix = int(chiffres)
    if prix > 500_000:
        raise RefusCommande("Le prix dépasse 500 000 GNF.")
    return prix


def prix_sans_solde_saisi(texte: str) -> int | None:
    """Case vide : l'étudiant sans solde paie le même prix."""
    if not re.sub(r"[^\d]", "", texte or ""):
        return None
    prix = prix_saisi(texte)
    if prix < 1:
        raise RefusCommande("Le prix sans solde doit être supérieur à 0 GNF.")
    return prix


def ajouter_plat(
    db, nom: str, description: str, prix: int, categorie_id: int, prix_sans_solde: int | None = None,
) -> Plat:
    """Ajoute un plat. Le QR code de la cantine n'est pas modifié."""
    categorie = db.get(CategoriePlat, int(categorie_id))
    if categorie is None:
        raise RefusCommande("Choisissez une catégorie.")
    titre = _titre(nom)
    plat = Plat(
        categorie_id=categorie.id,
        nom=titre,
        description=(description or "").strip()[:180],
        prix=prix,
        prix_sans_solde=prix_sans_solde,
        badge=None,
        visuel=_VISUELS.get(categorie.slug, "bol"),
        temps_min=15,
        stock=None,
        disponible=True,
        ordre=99,
    )
    db.add(plat)
    db.commit()
    return plat


def modifier_plat(
    db,
    plat_id: int,
    nom: str,
    description: str,
    prix: int,
    categorie_id: int,
    disponible: bool,
    prix_sans_solde: int | None = None,
) -> Plat:
    """Met à jour un plat. Le QR code de la cantine n'est pas modifié."""
    plat = db.get(Plat, plat_id)
    categorie = db.get(CategoriePlat, int(categorie_id))
    if plat is None or categorie is None:
        raise RefusCommande("Ce plat n'est plus dans le menu.")
    plat.nom = _titre(nom)
    plat.description = (description or "").strip()[:180]
    plat.prix = prix
    plat.prix_sans_solde = prix_sans_solde
    plat.categorie_id = categorie.id
    plat.visuel = _VISUELS.get(categorie.slug, plat.visuel)
    plat.disponible = disponible
    db.commit()
    return plat


def retirer_plat(db, plat_id: int) -> str:
    """Retire un plat. Les anciennes commandes gardent leur texte. Le QR code ne change pas."""
    plat = db.get(Plat, plat_id)
    if plat is None:
        raise RefusCommande("Ce plat n'est plus dans le menu.")
    nom = plat.nom
    photo = plat.photo_chemin
    db.execute(update(LigneCommande).where(LigneCommande.plat_id == plat.id).values(plat_id=None))
    db.delete(plat)
    db.commit()
    _effacer_photo(photo)
    return nom


def preparer_image_plat(blob: bytes) -> bytes:
    """Recadre une photo de plat en carré. N'accepte qu'une vraie image."""
    import io

    from PIL import Image, ImageOps

    if not blob:
        raise RefusCommande("Choisissez une image.")
    if len(blob) > 4_000_000:
        raise RefusCommande("L'image dépasse 4 Mo.")
    try:
        Image.open(io.BytesIO(blob)).verify()
        image = Image.open(io.BytesIO(blob))
        image.load()
    except Exception as exc:
        raise RefusCommande("Ce fichier n'est pas une image lisible (JPG, PNG ou WebP).") from exc
    image = ImageOps.exif_transpose(image)
    if image.mode in ("RGBA", "LA"):
        fond = Image.new("RGB", image.size, (244, 241, 234))
        fond.paste(image, mask=image.split()[-1])
        image = fond
    else:
        image = image.convert("RGB")
    if image.width < 200 or image.height < 200:
        raise RefusCommande("L'image est trop petite. Il faut au moins 200 pixels de côté.")
    cote = min(image.size)
    gauche = (image.width - cote) // 2
    haut = (image.height - cote) // 2
    image = image.crop((gauche, haut, gauche + cote, haut + cote))
    image = image.resize((900, 900), Image.Resampling.LANCZOS)
    sortie = io.BytesIO()
    image.save(sortie, format="JPEG", quality=90, optimize=True)
    return sortie.getvalue()


def poser_image_plat(db, plat: Plat, jpeg: bytes) -> None:
    from app.config import ROOT

    dossier = ROOT / "static" / "plats" / "perso"
    dossier.mkdir(parents=True, exist_ok=True)
    (dossier / f"{plat.id}.jpg").write_bytes(jpeg)
    plat.photo_chemin = f"perso/{plat.id}.jpg"
    db.commit()


def _effacer_photo(chemin: str | None) -> None:
    from app.config import ROOT

    if not chemin or not chemin.startswith("perso/") or ".." in chemin or not chemin.endswith(".jpg"):
        return
    (ROOT / "static" / "plats" / chemin).unlink(missing_ok=True)


def _titre(nom: str) -> str:
    titre = (nom or "").strip()
    if len(titre) < 2 or len(titre) > 80:
        raise RefusCommande("Le nom du plat doit contenir entre 2 et 80 caractères.")
    return titre


def _conscient(moment):
    if moment.tzinfo is None:
        from datetime import timezone

        return moment.replace(tzinfo=timezone.utc)
    return moment
