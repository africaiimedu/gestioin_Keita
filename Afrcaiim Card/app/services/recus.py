"""Reçus de la cantine : un par paiement validé, visibles par l'étudiant et la cuisine."""

from __future__ import annotations

import secrets
from datetime import date, datetime, time, timedelta, timezone

from sqlalchemy import func, select, update

from app.models import (
    CommandeCantine,
    Etudiant,
    LigneCommande,
    RecuCantine,
    TravailImpression,
    maintenant,
)
from app.services.courrier import formater_francs

NATURES = {
    "commande": "Commande cantine",
    "repas": "Repas validé à la carte",
    "recharge": "Recharge du compte cantine",
}
MODES = {
    "solde": "Compte cantine",
    "especes": "Espèces",
    "orange_money": "Orange Money",
    "versement": "Versement au bureau",
}
MODES_CAISSE = ("especes", "orange_money")


def details_lignes(lignes) -> str:
    texte = " ; ".join(f"{ligne.quantite} × {ligne.nom} ({formater_francs(ligne.prix * ligne.quantite)})" for ligne in lignes)
    return texte[:500]


def emettre_recu(
    db,
    etudiant: Etudiant,
    *,
    nature: str,
    mode: str,
    montant: int,
    solde_apres: int | None = None,
    commande: CommandeCantine | None = None,
    details: str = "",
    agent_id: int | None = None,
) -> RecuCantine:
    """Ajoute le reçu dans la transaction en cours. Le numéro suit l'ordre d'émission."""
    if nature not in NATURES or mode not in MODES:
        raise ValueError("Reçu cantine : nature ou mode inconnu.")
    recu = RecuCantine(
        numero=f"T{secrets.token_hex(6)}",
        etudiant_id=etudiant.id,
        commande_id=commande.id if commande is not None else None,
        nom_etudiant=f"{etudiant.prenom} {etudiant.nom}".strip()[:170],
        matricule=etudiant.matricule,
        nature=nature,
        mode=mode,
        montant=int(montant),
        solde_apres=solde_apres,
        details=(details or "")[:500],
        agent_id=agent_id,
        cree_le=maintenant(),
    )
    db.add(recu)
    db.flush()
    recu.numero = f"RC-{recu.id:06d}"
    return recu


def annuler_recus_commande(db, commande: CommandeCantine) -> None:
    db.execute(
        update(RecuCantine)
        .where(RecuCantine.commande_id == commande.id, RecuCantine.annule_le.is_(None))
        .values(annule_le=maintenant())
    )


def detacher_fiche(db, etudiant_id: int, commandes: list[int], cartes: list[int]) -> None:
    """Avant de retirer une fiche : les reçus restent, sans lien vers ce qui disparaît."""
    db.execute(update(RecuCantine).where(RecuCantine.etudiant_id == etudiant_id).values(etudiant_id=None))
    if commandes:
        db.execute(update(RecuCantine).where(RecuCantine.commande_id.in_(commandes)).values(commande_id=None))
    db.execute(update(TravailImpression).where(TravailImpression.etudiant_id == etudiant_id).values(etudiant_id=None))
    if cartes:
        db.execute(update(TravailImpression).where(TravailImpression.carte_id.in_(cartes)).values(carte_id=None))


def bornes(du: date, au: date) -> tuple[datetime, datetime]:
    """Conakry vit à l'heure UTC toute l'année."""
    debut = datetime.combine(du, time.min, tzinfo=timezone.utc)
    fin = datetime.combine(au + timedelta(days=1), time.min, tzinfo=timezone.utc)
    return debut, fin


def lister(db, du: date, au: date, etudiant_id: int | None = None, limite: int = 500) -> list[RecuCantine]:
    debut, fin = bornes(du, au)
    requete = select(RecuCantine).where(RecuCantine.cree_le >= debut, RecuCantine.cree_le < fin)
    if etudiant_id is not None:
        requete = requete.where(RecuCantine.etudiant_id == etudiant_id)
    return list(db.scalars(requete.order_by(RecuCantine.id.desc()).limit(limite)).all())


def rapport(db, du: date, au: date) -> dict:
    """Reçu = argent entré (caisse, Orange Money, recharges). Dépensé = repas consommés."""
    debut, fin = bornes(du, au)
    valides = (RecuCantine.cree_le >= debut, RecuCantine.cree_le < fin, RecuCantine.annule_le.is_(None))

    def somme(*conditions) -> tuple[int, int]:
        total, nombre = db.execute(
            select(func.coalesce(func.sum(RecuCantine.montant), 0), func.count(RecuCantine.id)).where(*valides, *conditions)
        ).one()
        return int(total), int(nombre)

    consommation = RecuCantine.nature.in_(("commande", "repas"))
    especes = somme(consommation, RecuCantine.mode == "especes")
    orange = somme(consommation, RecuCantine.mode == "orange_money")
    solde = somme(consommation, RecuCantine.mode == "solde")
    recharges = somme(RecuCantine.nature == "recharge")
    annules = db.scalar(
        select(func.count(RecuCantine.id)).where(RecuCantine.annule_le >= debut, RecuCantine.annule_le < fin)
    ) or 0

    jour = func.date(RecuCantine.cree_le)
    par_jour = []
    for valeur, mode, total in db.execute(
        select(jour, RecuCantine.mode, func.sum(RecuCantine.montant))
        .where(*valides, consommation)
        .group_by(jour, RecuCantine.mode)
        .order_by(jour)
    ).all():
        cle = valeur if isinstance(valeur, date) else date.fromisoformat(str(valeur)[:10])
        if not par_jour or par_jour[-1]["jour"] != cle:
            par_jour.append({"jour": cle, "caisse": 0, "solde": 0})
        par_jour[-1]["solde" if mode == "solde" else "caisse"] += int(total or 0)

    plats = [
        {"nom": nom, "quantite": int(quantite or 0), "montant": int(montant or 0)}
        for nom, quantite, montant in db.execute(
            select(
                LigneCommande.nom,
                func.sum(LigneCommande.quantite),
                func.sum(LigneCommande.quantite * LigneCommande.prix),
            )
            .join(RecuCantine, RecuCantine.commande_id == LigneCommande.commande_id)
            .where(*valides, RecuCantine.nature == "commande")
            .group_by(LigneCommande.nom)
            .order_by(func.sum(LigneCommande.quantite * LigneCommande.prix).desc())
        ).all()
    ]
    caisse = especes[0] + orange[0]
    return {
        "du": du,
        "au": au,
        "especes": especes,
        "orange_money": orange,
        "caisse": caisse,
        "solde": solde,
        "recharges": recharges,
        "depense": caisse + solde[0],
        "recu": caisse + recharges[0],
        "repas_scannes": somme(RecuCantine.nature == "repas"),
        "annules": int(annules),
        "par_jour": par_jour,
        "plats": plats,
    }
