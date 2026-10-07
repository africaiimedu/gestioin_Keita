"""Statuts affichés et libellés français."""

from __future__ import annotations

from datetime import date

LIBELLES_STATUT = {
    "active": "Valide",
    "expiree": "Expirée",
    "suspendue": "Suspendue",
    "perdue": "Perdue",
    "remplacee": "Remplacée",
}

LIBELLES_ACTION = {
    "creee": "Création",
    "importee": "Import",
    "generee": "PDF généré",
    "imprimee": "Marquée imprimée",
    "suspendue": "Suspension",
    "perdue": "Déclarée perdue",
    "reactivee": "Réactivation",
    "reeditee": "Réédition",
    "photo": "Photo mise à jour",
    "modification": "Fiche modifiée",
    "credit_cantine": "Compte cantine crédité",
    "debit_cantine": "Repas débité",
    "commande_cantine": "Commande cantine",
    "annulation_cantine": "Commande cantine annulée",
    "compte_cree": "Compte du personnel créé",
    "compte_actif": "Compte réactivé",
    "compte_inactif": "Compte désactivé",
    "compte_qr": "Autorisation QR modifiée",
    "qr_valide": "QR code validé",
}


LIBELLES_ROLE = {
    "admin": "Administrateur",
    "scolarite": "Scolarité",
    "cuisiniere": "Cuisinière",
    "securite": "Sécurité",
    "etudiant": "Étudiant",
}


def statut_effectif(statut: str, date_validite: date, aujourdhui: date | None = None) -> str:
    """Une carte active dont la date est passée s'affiche comme expirée."""
    aujourdhui = aujourdhui or date.today()
    if statut == "active" and date_validite < aujourdhui:
        return "expiree"
    return statut


def libelle_statut(statut: str) -> str:
    return LIBELLES_STATUT.get(statut, statut)


def libelle_action(action: str) -> str:
    return LIBELLES_ACTION.get(action, action)


def libelle_role(role: str) -> str:
    return LIBELLES_ROLE.get(role, role)
