"""Compte cantine : le QR de la carte montre le solde, puis un repas le débite."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import timezone

from sqlalchemy import select

from app.config import charger_config, definir_prix_repas
from app.models import Carte, Etudiant, MouvementCantine, maintenant
from app.services.courrier import expedier_debit, formater_francs
from app.services.import_etudiants import controler_email
from app.services.metier import journaliser
from app.services.recus import emettre_recu


@dataclass
class Decision:
    ok: bool
    message: str


def prix_repas() -> int:
    return int(charger_config()["prix_repas"])


def regler_prix(montant: int) -> int:
    if montant < 1 or montant > 5_000_000:
        raise ValueError("Le prix d'un repas doit être entre 1 et 5 000 000 francs guinéens.")
    definir_prix_repas(montant)
    return montant


def decision_repas(solde: int, prix: int, email: str, carte_active: bool) -> Decision:
    if not carte_active:
        return Decision(False, "Cette carte ne peut pas être utilisée à la cantine.")
    if not email:
        return Decision(False, "Aucun e-mail professionnel n'est inscrit sur la carte.")
    try:
        controler_email(email)
    except ValueError:
        return Decision(False, "L'e-mail professionnel inscrit sur la carte n'est pas valide.")
    if solde < prix:
        return Decision(
            False,
            f"Solde insuffisant : il reste {formater_francs(solde)}, le repas coûte {formater_francs(prix)}.",
        )
    return Decision(True, "")


def crediter(db, etudiant: Etudiant, montant: int, acteur_id: int | None) -> int:
    if montant < 1 or montant > 5_000_000:
        raise ValueError("Le montant à créditer doit être entre 1 et 5 000 000 francs guinéens.")
    etudiant = db.scalar(select(Etudiant).where(Etudiant.id == etudiant.id).with_for_update())
    etudiant.solde_cantine = int(etudiant.solde_cantine or 0) + montant
    db.add(
        MouvementCantine(
            etudiant_id=etudiant.id,
            montant=montant,
            solde_apres=etudiant.solde_cantine,
            agent_id=acteur_id,
            cree_le=maintenant(),
        )
    )
    recu = emettre_recu(
        db,
        etudiant,
        nature="recharge",
        mode="versement",
        montant=montant,
        solde_apres=etudiant.solde_cantine,
        agent_id=acteur_id,
    )
    journaliser(
        db,
        "credit_cantine",
        utilisateur_id=acteur_id,
        etudiant_id=etudiant.id,
        details=f"+{formater_francs(montant)} · reste {formater_francs(etudiant.solde_cantine)} · {recu.numero}",
    )
    db.commit()
    return etudiant.solde_cantine


def valider_repas(db, carte: Carte, agent_id: int) -> dict:
    etudiant = db.scalar(select(Etudiant).where(Etudiant.id == carte.etudiant_id).with_for_update())
    prix = prix_repas()
    decision = decision_repas(int(etudiant.solde_cantine or 0), prix, etudiant.email or "", True)
    if not decision.ok:
        db.rollback()
        raise ValueError(decision.message)
    dernier = db.scalar(
        select(MouvementCantine)
        .where(MouvementCantine.etudiant_id == etudiant.id, MouvementCantine.montant < 0)
        .order_by(MouvementCantine.id.desc())
    )
    if dernier is not None and _secondes(dernier.cree_le) < 60:
        db.rollback()
        raise ValueError("Ce repas vient d'être validé. Attendez une minute avant un nouveau passage.")
    etudiant.solde_cantine = int(etudiant.solde_cantine) - prix
    db.add(
        MouvementCantine(
            etudiant_id=etudiant.id,
            carte_id=carte.id,
            agent_id=agent_id,
            montant=-prix,
            solde_apres=etudiant.solde_cantine,
            cree_le=maintenant(),
        )
    )
    recu = emettre_recu(
        db,
        etudiant,
        nature="repas",
        mode="solde",
        montant=prix,
        solde_apres=etudiant.solde_cantine,
        details="1 × Repas",
        agent_id=agent_id,
    )
    envoye = expedier_debit(etudiant.email, etudiant.prenom, etudiant.nom, prix, etudiant.solde_cantine)
    suite = "e-mail envoyé" if envoye else "e-mail en attente : le serveur de messagerie n'est pas configuré"
    journaliser(
        db,
        "debit_cantine",
        utilisateur_id=agent_id,
        etudiant_id=etudiant.id,
        carte_id=carte.id,
        details=f"-{formater_francs(prix)} · reste {formater_francs(etudiant.solde_cantine)} · {recu.numero} · {suite}",
    )
    db.commit()
    return {
        "montant": prix,
        "solde": etudiant.solde_cantine,
        "email": etudiant.email,
        "envoye": envoye,
        "recu_id": recu.id,
        "recu_numero": recu.numero,
    }


def _secondes(moment) -> float:
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return (maintenant() - moment).total_seconds()
