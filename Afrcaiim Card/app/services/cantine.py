"""Compte cantine : le QR de la carte montre le solde, puis un repas le débite."""

from __future__ import annotations

from calendar import monthrange
from dataclasses import dataclass
from datetime import date, timezone

from sqlalchemy import select

from app.config import charger_config, definir_prix_repas
from app.models import Carte, Etudiant, MouvementCantine, Personnel, RecuCantine, maintenant
from app.services.courrier import formater_francs
from app.services.import_etudiants import controler_email
from app.services.metier import journaliser
from app.services.recus import emettre_recu


@dataclass
class Decision:
    ok: bool
    message: str


ABONNEMENT_ETUDIANT = 600_000
ABONNEMENT_PERSONNEL = 800_000
ABONNEMENT_MENSUEL = ABONNEMENT_ETUDIANT
MOIS_MAX = 12


def mois_abonnement(valeur) -> int:
    try:
        mois = int(str(valeur).strip())
    except (TypeError, ValueError) as exc:
        raise ValueError("Indiquez une durée en mois, de 1 à 12.") from exc
    if mois < 1 or mois > MOIS_MAX:
        raise ValueError("L'abonnement va de 1 à 12 mois.")
    return mois


def parse_montant_gnf(valeur) -> int:
    texte = str(valeur or "").strip().upper().replace("GNF", "").replace("FG", "")
    texte = texte.replace("\u00a0", "").replace(" ", "").replace(".", "").replace(",", "")
    try:
        return int(texte)
    except (TypeError, ValueError) as exc:
        raise ValueError("Indiquez un montant en francs guinéens.") from exc


def qualite_titulaire(titulaire) -> str:
    return "personnel" if getattr(titulaire, "__tablename__", "") == "personnels" else "etudiant"


def tarif_mensuel(qualite: str = "etudiant") -> int:
    return ABONNEMENT_PERSONNEL if qualite == "personnel" else ABONNEMENT_ETUDIANT


def montant_mensuel(valeur=None, qualite: str = "etudiant") -> int:
    if valeur is None or str(valeur).strip() == "":
        return tarif_mensuel(qualite)
    montant = parse_montant_gnf(valeur)
    if montant < 1_000 or montant > 50_000_000:
        raise ValueError("Le montant mensuel doit être entre 1.000 et 50.000.000 GNF.")
    return montant


def ajouter_mois(debut: date, mois: int) -> date:
    total = debut.month - 1 + mois
    annee = debut.year + total // 12
    mois_out = total % 12 + 1
    jour = min(debut.day, monthrange(annee, mois_out)[1])
    return date(annee, mois_out, jour)


def montant_abonnement(mois: int, mensuel=None, qualite: str = "etudiant") -> int:
    return mois_abonnement(mois) * montant_mensuel(mensuel, qualite)


def montant_abonnement_etudiant(titulaire) -> int:
    stocke = int(getattr(titulaire, "abonnement_montant", 0) or 0)
    if stocke > 0:
        return stocke
    mois = int(getattr(titulaire, "abonnement_mois", 0) or 0)
    qualite = getattr(titulaire, "qualite_abonne", None) or qualite_titulaire(titulaire)
    return montant_abonnement(mois or 1, qualite=qualite)


def est_abonne(titulaire, aujourdhui: date | None = None) -> bool:
    if not bool(getattr(titulaire, "abonne_cantine", False)):
        return False
    fin = getattr(titulaire, "abonnement_fin", None)
    if fin is None:
        return True
    return (aujourdhui or date.today()) <= fin


def _preparer_abonne(titulaire, qualite: str):
    titulaire.qualite_abonne = qualite
    if qualite == "personnel":
        titulaire.filiere = getattr(titulaire, "fonction", "") or "Personnel"
        titulaire.programme = ""
        titulaire.niveau = ""
    return titulaire


def lister_abonnes(db, aujourdhui: date | None = None) -> list:
    """Abonnements encore valables aujourd'hui, étudiants et personnel."""
    jour = aujourdhui or date.today()
    etudiants = [
        _preparer_abonne(e, "etudiant")
        for e in db.scalars(
            select(Etudiant).where(Etudiant.abonne_cantine.is_(True)).order_by(Etudiant.nom, Etudiant.prenom, Etudiant.id)
        ).all()
        if est_abonne(e, jour)
    ]
    personnels = [
        _preparer_abonne(p, "personnel")
        for p in db.scalars(
            select(Personnel).where(Personnel.abonne_cantine.is_(True)).order_by(Personnel.nom, Personnel.prenom, Personnel.id)
        ).all()
        if est_abonne(p, jour)
    ]
    return sorted(etudiants + personnels, key=lambda x: ((x.nom or "").lower(), (x.prenom or "").lower(), x.id))


def libelle_abonnement(titulaire) -> str:
    if not est_abonne(titulaire):
        return "Non abonné · paiement à la caisse"
    mois = int(getattr(titulaire, "abonnement_mois", 0) or 0)
    fin = getattr(titulaire, "abonnement_fin", None)
    total = montant_abonnement_etudiant(titulaire)
    par_mois = total // mois if mois else tarif_mensuel(qualite_titulaire(titulaire))
    profil = "Personnel" if qualite_titulaire(titulaire) == "personnel" else "Étudiant"
    morceaux = [f"Abonné ({profil})"]
    if mois:
        morceaux.append(f"{mois} mois")
    morceaux.append(f"{formater_francs(par_mois)} / mois")
    morceaux.append(f"total {formater_francs(total)}")
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


def poser_abonnement(db, titulaire, acteur_id: int | None, mois=1, mensuel=None):
    """Pose l'abonnement (étudiant 600.000 GNF / personnel 800.000 GNF par défaut) avec montant et durée choisis."""
    qualite = qualite_titulaire(titulaire)
    est_personnel = qualite == "personnel"
    duree = mois_abonnement(mois)
    par_mois = montant_mensuel(mensuel, qualite)
    total = duree * par_mois
    debut = date.today()
    fin = ajouter_mois(debut, duree)
    if est_personnel:
        titulaire = db.scalar(select(Personnel).where(Personnel.id == titulaire.id).with_for_update())
        message_deja = "Ce membre du personnel a déjà un abonnement cantine en cours."
    else:
        titulaire = db.scalar(select(Etudiant).where(Etudiant.id == titulaire.id).with_for_update())
        message_deja = "Cet étudiant a déjà un abonnement cantine en cours."
    if est_abonne(titulaire):
        db.rollback()
        limite = getattr(titulaire, "abonnement_fin", None)
        if limite:
            raise ValueError(f"Déjà abonné jusqu'au {limite.strftime('%d/%m/%Y')}.")
        raise ValueError(message_deja)
    profil = "personnel" if est_personnel else "étudiant"
    details = (
        f"{profil} · {duree} mois · {formater_francs(par_mois)} / mois · total {formater_francs(total)} · "
        f"du {debut.strftime('%d/%m/%Y')} au {fin.strftime('%d/%m/%Y')} · "
        "plat du jour et une bouteille d'eau. Aucun débit à chaque repas."
    )
    deja_verse = None
    if not est_personnel:
        deja_verse = db.scalar(
            select(RecuCantine)
            .where(
                RecuCantine.etudiant_id == titulaire.id,
                RecuCantine.nature == "recharge",
                RecuCantine.montant == total,
                RecuCantine.annule_le.is_(None),
            )
            .order_by(RecuCantine.id.desc())
        )
    titulaire.abonne_cantine = True
    titulaire.abonnement_mois = duree
    titulaire.abonnement_fin = fin
    titulaire.abonnement_montant = total
    if deja_verse is not None:
        if int(titulaire.solde_cantine or 0) >= total:
            titulaire.solde_cantine = int(titulaire.solde_cantine or 0) - total
            db.add(
                MouvementCantine(
                    etudiant_id=titulaire.id,
                    montant=-total,
                    solde_apres=titulaire.solde_cantine,
                    agent_id=acteur_id,
                    cree_le=maintenant(),
                )
            )
        deja_verse.nature = "abonnement"
        deja_verse.mode = "abonnement"
        deja_verse.details = details
        deja_verse.solde_apres = int(titulaire.solde_cantine or 0)
        recu = deja_verse
    else:
        recu = emettre_recu(
            db,
            None if est_personnel else titulaire,
            nature="abonnement",
            mode="abonnement",
            montant=total,
            solde_apres=int(titulaire.solde_cantine or 0),
            agent_id=acteur_id,
            details=details,
            personnel=titulaire if est_personnel else None,
        )
    journaliser(
        db,
        "abonnement_cantine",
        utilisateur_id=acteur_id,
        etudiant_id=None if est_personnel else titulaire.id,
        details=(
            f"{profil} · {duree} mois · {formater_francs(par_mois)} / mois · "
            f"{formater_francs(total)} · jusqu'au {fin.strftime('%d/%m/%Y')} · {recu.numero}"
        ),
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
