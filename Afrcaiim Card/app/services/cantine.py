"""Compte cantine : le QR de la carte montre le solde, puis un repas le débite."""

from __future__ import annotations

from calendar import monthrange
from dataclasses import dataclass
from datetime import date, timezone

from sqlalchemy import select

from app.config import charger_config, definir_prix_repas
from app.models import Carte, Etudiant, MouvementCantine, maintenant
from app.services.courrier import formater_francs
from app.services.import_etudiants import controler_email
from app.services.metier import journaliser
from app.services.recus import emettre_recu


@dataclass
class Decision:
    ok: bool
    message: str


ABONNEMENT_MENSUEL = 600_000
MOIS_MAX = 12


def mois_abonnement(valeur) -> int:
    try:
        mois = int(str(valeur).strip())
    except (TypeError, ValueError) as exc:
        raise ValueError("Indiquez une durée en mois, de 1 à 12.") from exc
    if mois < 1 or mois > MOIS_MAX:
        raise ValueError("L'abonnement va de 1 à 12 mois.")
    return mois


def ajouter_mois(debut: date, mois: int) -> date:
    total = debut.month - 1 + mois
    annee = debut.year + total // 12
    mois_out = total % 12 + 1
    jour = min(debut.day, monthrange(annee, mois_out)[1])
    return date(annee, mois_out, jour)


def montant_abonnement(mois: int) -> int:
    return ABONNEMENT_MENSUEL * mois_abonnement(mois)


def est_abonne(etudiant: Etudiant, aujourdhui: date | None = None) -> bool:
    if not bool(getattr(etudiant, "abonne_cantine", False)):
        return False
    fin = getattr(etudiant, "abonnement_fin", None)
    if fin is None:
        return True
    return (aujourdhui or date.today()) <= fin


def libelle_abonnement(etudiant: Etudiant) -> str:
    if not est_abonne(etudiant):
        return "Non abonné · paiement à la caisse"
    mois = int(getattr(etudiant, "abonnement_mois", 0) or 0)
    fin = getattr(etudiant, "abonnement_fin", None)
    morceaux = ["Abonné"]
    if mois:
        morceaux.append(f"{mois} mois")
    morceaux.append(f"{formater_francs(ABONNEMENT_MENSUEL)} / mois")
    if fin:
        morceaux.append(f"jusqu'au {fin.strftime('%d/%m/%Y')}")
    morceaux.append("aucun débit")
    return " · ".join(morceaux)


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
        return Decision(False, "Aucun e-mail étudiant n'est inscrit sur la carte.")
    try:
        controler_email(email)
    except ValueError:
        return Decision(False, "L'e-mail étudiant inscrit sur la carte n'est pas valide.")
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


def poser_abonnement(db, etudiant: Etudiant, acteur_id: int | None, mois=1):
    """Pose l'abonnement sur la fiche choisie, 600 000 FG par mois, et émet le reçu."""
    duree = mois_abonnement(mois)
    total = montant_abonnement(duree)
    debut = date.today()
    fin = ajouter_mois(debut, duree)
    etudiant = db.scalar(select(Etudiant).where(Etudiant.id == etudiant.id).with_for_update())
    if est_abonne(etudiant):
        db.rollback()
        limite = getattr(etudiant, "abonnement_fin", None)
        if limite:
            raise ValueError(f"Déjà abonné jusqu'au {limite.strftime('%d/%m/%Y')}.")
        raise ValueError("Cet étudiant a déjà un abonnement cantine en cours.")
    etudiant.abonne_cantine = True
    etudiant.abonnement_mois = duree
    etudiant.abonnement_fin = fin
    recu = emettre_recu(
        db,
        etudiant,
        nature="abonnement",
        mode="abonnement",
        montant=total,
        solde_apres=int(etudiant.solde_cantine or 0),
        agent_id=acteur_id,
        details=(
            f"{duree} mois · du {debut.strftime('%d/%m/%Y')} au {fin.strftime('%d/%m/%Y')} · "
            "plat du jour et une bouteille d'eau. Aucun débit à chaque repas."
        ),
    )
    journaliser(
        db,
        "abonnement_cantine",
        utilisateur_id=acteur_id,
        etudiant_id=etudiant.id,
        details=f"{duree} mois · {formater_francs(total)} · jusqu'au {fin.strftime('%d/%m/%Y')} · {recu.numero}",
    )
    db.commit()
    return recu


def valider_repas(db, carte: Carte, agent_id: int) -> dict:
    etudiant = db.scalar(select(Etudiant).where(Etudiant.id == carte.etudiant_id).with_for_update())
    if not est_abonne(etudiant):
        db.rollback()
        raise ValueError("Étudiant non abonné à la cantine : le repas se paie à la caisse.")
    prix = prix_repas()
    if not (etudiant.email or "").strip():
        db.rollback()
        raise ValueError("Aucun e-mail étudiant n'est inscrit sur la carte.")
    dernier = db.scalar(
        select(MouvementCantine)
        .where(MouvementCantine.etudiant_id == etudiant.id, MouvementCantine.montant < 0)
        .order_by(MouvementCantine.id.desc())
    )
    if dernier is not None and _secondes(dernier.cree_le) < 60:
        db.rollback()
        raise ValueError("Ce repas vient d'être validé. Attendez une minute avant un nouveau passage.")
    recu = emettre_recu(
        db,
        etudiant,
        nature="repas",
        mode="abonnement",
        montant=prix,
        solde_apres=int(etudiant.solde_cantine or 0),
        details="1 × Repas · abonnement cantine, aucun débit",
        agent_id=agent_id,
    )
    journaliser(
        db,
        "commande_cantine",
        utilisateur_id=agent_id,
        etudiant_id=etudiant.id,
        carte_id=carte.id,
        details=f"{formater_francs(prix)} · abonnement cantine, aucun débit · {recu.numero}",
    )
    db.commit()
    return {
        "montant": prix,
        "solde": etudiant.solde_cantine,
        "email": etudiant.email,
        "envoye": False,
        "recu_id": recu.id,
        "recu_numero": recu.numero,
    }


def _secondes(moment) -> float:
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return (maintenant() - moment).total_seconds()
