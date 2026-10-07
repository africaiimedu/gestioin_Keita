"""Création des fiches, des cartes et du journal."""

from __future__ import annotations

import re
from datetime import date

from sqlalchemy import delete, func, select
from sqlalchemy.exc import IntegrityError

from app.config import ROOT
from app.models import (
    Carte,
    CommandeCantine,
    Etudiant,
    Journal,
    LigneCommande,
    MouvementCantine,
    Utilisateur,
    maintenant,
)
from app.security import hash_mot_de_passe, mot_de_passe_temporaire, nouveau_jeton
from app.services.photos import enregistrer_photo
from app.services.statut import statut_effectif


def journaliser(
    db,
    action: str,
    *,
    utilisateur_id: int | None = None,
    etudiant_id: int | None = None,
    carte_id: int | None = None,
    details: str = "",
) -> None:
    db.add(
        Journal(
            action=action,
            utilisateur_id=utilisateur_id,
            etudiant_id=etudiant_id,
            carte_id=carte_id,
            details=details[:500],
            cree_le=maintenant(),
        )
    )


def courante_parmi(cartes: list[Carte]) -> Carte | None:
    vivantes = [carte for carte in cartes if carte.statut != "remplacee"]
    if not vivantes:
        return None
    return max(vivantes, key=lambda carte: carte.numero_edition)


def carte_courante(db, etudiant_id: int) -> Carte | None:
    cartes = db.scalars(select(Carte).where(Carte.etudiant_id == etudiant_id)).all()
    return courante_parmi(list(cartes))


def _nouvelle_carte(etudiant: Etudiant, edition: int, uid_nfc: str | None = None) -> Carte:
    return Carte(
        etudiant_id=etudiant.id,
        jeton=nouveau_jeton(),
        statut="active",
        date_emission=date.today(),
        date_validite=etudiant.date_validite,
        numero_edition=edition,
        uid_nfc=uid_nfc,
        cree_le=maintenant(),
    )


def creer_etudiant(
    db,
    *,
    prenom: str,
    nom: str,
    matricule: str,
    filiere: str,
    annee_academique: str,
    date_validite: date,
    jpeg: bytes | None = None,
    email: str = "",
    sexe: str = "M",
    mot_de_passe: str | None = None,
    acteur_id: int | None = None,
    action: str = "creee",
    details: str = "Fiche et carte créées",
) -> tuple[Etudiant, str]:
    try:
        etudiant = Etudiant(
            prenom=prenom,
            nom=nom,
            matricule=matricule,
            filiere=filiere,
            annee_academique=annee_academique,
            date_validite=date_validite,
            email=email or "",
            sexe=sexe if sexe in {"M", "F"} else "M",
            solde_cantine=0,
            cree_le=maintenant(),
        )
        db.add(etudiant)
        db.flush()
        if jpeg:
            etudiant.photo_chemin = enregistrer_photo(etudiant.id, jpeg)
        secret = mot_de_passe or mot_de_passe_temporaire()
        db.add(
            Utilisateur(
                identifiant=matricule,
                mot_de_passe_hash=hash_mot_de_passe(secret),
                role="etudiant",
                actif=True,
                doit_changer_mot_de_passe=True,
                etudiant_id=etudiant.id,
                cree_le=maintenant(),
            )
        )
        carte = _nouvelle_carte(etudiant, 1)
        db.add(carte)
        db.flush()
        journaliser(
            db,
            action,
            utilisateur_id=acteur_id,
            etudiant_id=etudiant.id,
            carte_id=carte.id,
            details=details,
        )
        db.commit()
        db.refresh(etudiant)
        return etudiant, secret
    except IntegrityError as exc:
        db.rollback()
        raise ValueError(f"Le matricule {matricule} existe déjà.") from exc
    except Exception:
        db.rollback()
        raise


def supprimer_etudiant(db, etudiant: Etudiant) -> None:
    """Retire la fiche, sa carte, son compte et ses commandes. Le site de l'université appelle cette porte."""
    matricule = etudiant.matricule
    if etudiant.photo_chemin:
        chemin = (ROOT / etudiant.photo_chemin).resolve()
        if ROOT.resolve() in chemin.parents or chemin.parent == ROOT.resolve():
            chemin.unlink(missing_ok=True)
    commandes = db.scalars(select(CommandeCantine.id).where(CommandeCantine.etudiant_id == etudiant.id)).all()
    if commandes:
        db.execute(delete(LigneCommande).where(LigneCommande.commande_id.in_(commandes)))
        db.execute(delete(CommandeCantine).where(CommandeCantine.id.in_(commandes)))
    db.execute(delete(MouvementCantine).where(MouvementCantine.etudiant_id == etudiant.id))
    db.execute(delete(Journal).where(Journal.etudiant_id == etudiant.id))
    identifiants = [carte.id for carte in etudiant.cartes]
    if identifiants:
        db.execute(delete(Journal).where(Journal.carte_id.in_(identifiants)))
        db.execute(delete(MouvementCantine).where(MouvementCantine.carte_id.in_(identifiants)))
    db.execute(delete(Carte).where(Carte.etudiant_id == etudiant.id))
    db.execute(delete(Utilisateur).where(Utilisateur.etudiant_id == etudiant.id))
    db.delete(etudiant)
    journaliser(db, "supprimee", details=f"Fiche {matricule} retirée par le site")
    db.commit()


def modifier_etudiant(
    db,
    etudiant: Etudiant,
    *,
    prenom: str,
    nom: str,
    filiere: str,
    annee_academique: str,
    date_validite: date,
    email: str = "",
    sexe: str = "",
    acteur_id: int | None,
) -> None:
    etudiant.prenom = prenom
    etudiant.nom = nom
    etudiant.filiere = filiere
    etudiant.annee_academique = annee_academique
    etudiant.date_validite = date_validite
    etudiant.email = email or ""
    if sexe in {"M", "F"}:
        etudiant.sexe = sexe
    carte = carte_courante(db, etudiant.id)
    if carte and carte.statut != "remplacee":
        carte.date_validite = date_validite
    journaliser(
        db,
        "modification",
        utilisateur_id=acteur_id,
        etudiant_id=etudiant.id,
        carte_id=carte.id if carte else None,
        details="Fiche mise à jour",
    )
    db.commit()


def changer_statut(db, carte: Carte, statut: str, acteur_id: int | None) -> str | None:
    if statut not in {"active", "suspendue", "perdue"}:
        raise ValueError("Statut inconnu.")
    if carte.statut == "remplacee":
        raise ValueError("Cette édition a été remplacée. Utilisez Rééditer.")
    carte.statut = statut
    action = "reactivee" if statut == "active" else statut
    journaliser(
        db,
        action,
        utilisateur_id=acteur_id,
        etudiant_id=carte.etudiant_id,
        carte_id=carte.id,
        details="",
    )
    db.commit()
    avertissement = None
    if statut_effectif(carte.statut, carte.date_validite) == "expiree":
        avertissement = (
            "La carte est marquée active, mais la date est dépassée : "
            "elle s'affichera comme expirée. Modifiez la date ou rééditez-la."
        )
    return avertissement


def reediter(db, etudiant: Etudiant, acteur_id: int | None) -> Carte:
    anciennes = db.scalars(select(Carte).where(Carte.etudiant_id == etudiant.id)).all()
    edition = 1
    uid = None
    for carte in anciennes:
        if carte.statut != "remplacee":
            if carte.uid_nfc:
                uid = carte.uid_nfc
            carte.statut = "remplacee"
        edition = max(edition, carte.numero_edition + 1)
    nouvelle = _nouvelle_carte(etudiant, edition, uid)
    db.add(nouvelle)
    db.flush()
    journaliser(
        db,
        "reeditee",
        utilisateur_id=acteur_id,
        etudiant_id=etudiant.id,
        carte_id=nouvelle.id,
        details=f"Édition {edition}. L'ancien QR code ne fonctionne plus.",
    )
    db.commit()
    return nouvelle


def enregistrer_uid(db, carte: Carte, uid: str, acteur_id: int | None) -> None:
    carte.uid_nfc = uid or None
    journaliser(
        db,
        "modification",
        utilisateur_id=acteur_id,
        etudiant_id=carte.etudiant_id,
        carte_id=carte.id,
        details="Identifiant de puce enregistré" if uid else "Identifiant de puce effacé",
    )
    db.commit()


def remplacer_photo(db, etudiant: Etudiant, jpeg: bytes, acteur_id: int | None) -> None:
    etudiant.photo_chemin = enregistrer_photo(etudiant.id, jpeg)
    carte = carte_courante(db, etudiant.id)
    journaliser(
        db,
        "photo",
        utilisateur_id=acteur_id,
        etudiant_id=etudiant.id,
        carte_id=carte.id if carte else None,
        details="Portrait recadré",
    )
    db.commit()


def marquer_imprimee(db, carte: Carte, acteur_id: int | None, details: str) -> None:
    journaliser(
        db,
        "imprimee",
        utilisateur_id=acteur_id,
        etudiant_id=carte.etudiant_id,
        carte_id=carte.id,
        details=details,
    )
    db.commit()


def noter_generation(db, carte: Carte, acteur_id: int | None, details: str) -> None:
    journaliser(
        db,
        "generee",
        utilisateur_id=acteur_id,
        etudiant_id=carte.etudiant_id,
        carte_id=carte.id,
        details=details,
    )
    db.commit()


ROLES_PERSONNEL = (
    ("scolarite", "Scolarité"),
    ("cuisiniere", "Cuisinière"),
    ("securite", "Sécurité"),
)
_ROLES_CREABLES = {code for code, _libelle in ROLES_PERSONNEL}
_IDENTIFIANT = re.compile(r"^[a-z0-9][a-z0-9._-]{2,39}$")


def controler_compte(identifiant: str, mot_de_passe: str, confirmation: str, role: str) -> tuple[str, str, str]:
    """Vérifie un compte du personnel avant de l'enregistrer."""
    identifiant = (identifiant or "").strip().lower()
    role = (role or "").strip().lower()
    if not _IDENTIFIANT.match(identifiant):
        raise ValueError(
            "L'identifiant doit faire au moins 3 caractères : lettres, chiffres, point, tiret."
        )
    if role not in _ROLES_CREABLES:
        raise ValueError("Choisissez la scolarité, la cuisinière ou la sécurité.")
    if len(mot_de_passe or "") < 10 or len(mot_de_passe) > 200:
        raise ValueError("Le mot de passe doit contenir au moins 10 caractères.")
    if mot_de_passe != confirmation:
        raise ValueError("Les deux mots de passe ne sont pas identiques.")
    if mot_de_passe.lower() == identifiant:
        raise ValueError("Le mot de passe ne doit pas être identique à l'identifiant.")
    return identifiant, mot_de_passe, role


def creer_compte_personnel(
    db,
    identifiant: str,
    mot_de_passe: str,
    confirmation: str,
    role: str,
    acteur_id: int | None,
    peut_valider_qr: bool = False,
) -> Utilisateur:
    identifiant, mot_de_passe, role = controler_compte(identifiant, mot_de_passe, confirmation, role)
    existe = db.scalar(
        select(Utilisateur).where(func.lower(Utilisateur.identifiant) == identifiant)
    )
    if existe is not None:
        raise ValueError("Cet identifiant est déjà utilisé.")
    compte = Utilisateur(
        identifiant=identifiant,
        mot_de_passe_hash=hash_mot_de_passe(mot_de_passe),
        role=role,
        actif=True,
        peut_valider_qr=bool(peut_valider_qr),
        doit_changer_mot_de_passe=True,
        cree_le=maintenant(),
    )
    db.add(compte)
    db.flush()
    journaliser(
        db,
        "compte_cree",
        utilisateur_id=acteur_id,
        details=f"{identifiant} · {role}",
    )
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise ValueError("Cet identifiant est déjà utilisé.") from exc
    db.refresh(compte)
    return compte


def basculer_compte(db, compte_id: int, acteur_id: int | None) -> Utilisateur:
    compte = db.get(Utilisateur, compte_id)
    if compte is None or compte.role not in _ROLES_CREABLES:
        raise ValueError("Ce compte ne peut pas être modifié ici.")
    if compte.id == acteur_id:
        raise ValueError("Vous ne pouvez pas désactiver votre propre compte.")
    compte.actif = not compte.actif
    journaliser(
        db,
        "compte_actif" if compte.actif else "compte_inactif",
        utilisateur_id=acteur_id,
        details=compte.identifiant,
    )
    db.commit()
    return compte


def basculer_validation_qr(db, compte_id: int, acteur_id: int | None) -> Utilisateur:
    compte = db.get(Utilisateur, compte_id)
    if compte is None or compte.role not in _ROLES_CREABLES:
        raise ValueError("Ce compte ne peut pas être modifié ici.")
    compte.peut_valider_qr = not compte.peut_valider_qr
    etat = "autorisée" if compte.peut_valider_qr else "retirée"
    journaliser(
        db,
        "compte_qr",
        utilisateur_id=acteur_id,
        details=f"{compte.identifiant} · validation QR {etat}",
    )
    db.commit()
    return compte


def reinitialiser_mot_de_passe(db, etudiant: Etudiant) -> str:
    utilisateur = db.scalar(select(Utilisateur).where(Utilisateur.etudiant_id == etudiant.id))
    if utilisateur is None:
        raise ValueError("Cet étudiant n'a pas de compte.")
    secret = mot_de_passe_temporaire()
    utilisateur.mot_de_passe_hash = hash_mot_de_passe(secret)
    utilisateur.doit_changer_mot_de_passe = True
    db.commit()
    return secret


def matricules_existants(db) -> set[str]:
    return set(db.scalars(select(Etudiant.matricule)).all())


def filieres_et_annees(db) -> tuple[list[str], list[str]]:
    from app.services.ecoles import ECOLES, annee_academique_courante

    return list(ECOLES), [annee_academique_courante()]


def compter(db) -> dict:
    total = db.scalar(select(func.count()).select_from(Etudiant)) or 0
    return {"etudiants": total}
