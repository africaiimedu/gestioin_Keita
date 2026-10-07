"""Tables : étudiants, comptes, cartes, journal."""

from __future__ import annotations

from datetime import date, datetime, timezone

from sqlalchemy import Boolean, Date, DateTime, ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


def maintenant() -> datetime:
    return datetime.now(timezone.utc)


class Etudiant(Base):
    __tablename__ = "etudiants"

    id: Mapped[int] = mapped_column(primary_key=True)
    prenom: Mapped[str] = mapped_column(String(80))
    nom: Mapped[str] = mapped_column(String(80))
    matricule: Mapped[str] = mapped_column(String(40), unique=True, index=True)
    filiere: Mapped[str] = mapped_column(String(150))
    sexe: Mapped[str] = mapped_column(String(1), default="M")
    annee_academique: Mapped[str] = mapped_column(String(9))
    date_validite: Mapped[date] = mapped_column(Date)
    photo_chemin: Mapped[str | None] = mapped_column(String(255), nullable=True)
    email: Mapped[str] = mapped_column(String(120), default="")
    solde_cantine: Mapped[int] = mapped_column(Integer, default=0)
    cree_le: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=maintenant)

    cartes: Mapped[list[Carte]] = relationship(back_populates="etudiant")


class Utilisateur(Base):
    __tablename__ = "utilisateurs"

    id: Mapped[int] = mapped_column(primary_key=True)
    identifiant: Mapped[str] = mapped_column(String(80), unique=True, index=True)
    mot_de_passe_hash: Mapped[str] = mapped_column(String(255))
    role: Mapped[str] = mapped_column(String(20))
    actif: Mapped[bool] = mapped_column(default=True)
    peut_valider_qr: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    doit_changer_mot_de_passe: Mapped[bool] = mapped_column(default=True)
    pin_cantine_hash: Mapped[str | None] = mapped_column(String(255), nullable=True)
    etudiant_id: Mapped[int | None] = mapped_column(ForeignKey("etudiants.id"), unique=True, nullable=True)
    cree_le: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=maintenant)


class Carte(Base):
    __tablename__ = "cartes"

    id: Mapped[int] = mapped_column(primary_key=True)
    etudiant_id: Mapped[int] = mapped_column(ForeignKey("etudiants.id"), index=True)
    jeton: Mapped[str] = mapped_column(String(80), unique=True, index=True)
    statut: Mapped[str] = mapped_column(String(20), index=True)
    date_emission: Mapped[date] = mapped_column(Date)
    date_validite: Mapped[date] = mapped_column(Date)
    numero_edition: Mapped[int] = mapped_column(default=1)
    uid_nfc: Mapped[str | None] = mapped_column(String(40), nullable=True)
    cree_le: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=maintenant)

    etudiant: Mapped[Etudiant] = relationship(back_populates="cartes")


class MouvementCantine(Base):
    __tablename__ = "mouvements_cantine"

    id: Mapped[int] = mapped_column(primary_key=True)
    etudiant_id: Mapped[int] = mapped_column(ForeignKey("etudiants.id"), index=True)
    carte_id: Mapped[int | None] = mapped_column(ForeignKey("cartes.id"), nullable=True)
    agent_id: Mapped[int | None] = mapped_column(ForeignKey("utilisateurs.id"), nullable=True)
    montant: Mapped[int] = mapped_column(Integer)
    solde_apres: Mapped[int] = mapped_column(Integer)
    cree_le: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=maintenant)


class PointCantine(Base):
    __tablename__ = "points_cantine"

    id: Mapped[int] = mapped_column(primary_key=True)
    nom: Mapped[str] = mapped_column(String(80))
    jeton: Mapped[str] = mapped_column(String(80), unique=True, index=True)
    actif: Mapped[bool] = mapped_column(default=True)


class CategoriePlat(Base):
    __tablename__ = "categories_plats"

    id: Mapped[int] = mapped_column(primary_key=True)
    nom: Mapped[str] = mapped_column(String(40))
    slug: Mapped[str] = mapped_column(String(40), unique=True)
    ordre: Mapped[int] = mapped_column(Integer, default=0)


class Plat(Base):
    __tablename__ = "plats"

    id: Mapped[int] = mapped_column(primary_key=True)
    categorie_id: Mapped[int] = mapped_column(ForeignKey("categories_plats.id"), index=True)
    nom: Mapped[str] = mapped_column(String(80))
    description: Mapped[str] = mapped_column(String(180), default="")
    prix: Mapped[int] = mapped_column(Integer)
    badge: Mapped[str | None] = mapped_column(String(24), nullable=True)
    visuel: Mapped[str] = mapped_column(String(20), default="bol")
    temps_min: Mapped[int] = mapped_column(Integer, default=15)
    stock: Mapped[int | None] = mapped_column(Integer, nullable=True)
    disponible: Mapped[bool] = mapped_column(default=True)
    ordre: Mapped[int] = mapped_column(Integer, default=0)
    photo_chemin: Mapped[str | None] = mapped_column(String(120), nullable=True)


class CommandeCantine(Base):
    __tablename__ = "commandes_cantine"

    id: Mapped[int] = mapped_column(primary_key=True)
    numero: Mapped[str] = mapped_column(String(12), unique=True)
    etudiant_id: Mapped[int] = mapped_column(ForeignKey("etudiants.id"), index=True)
    point_id: Mapped[int] = mapped_column(ForeignKey("points_cantine.id"))
    montant: Mapped[int] = mapped_column(Integer)
    statut: Mapped[str] = mapped_column(String(20), index=True, default="recue")
    cle: Mapped[str] = mapped_column(String(64), unique=True)
    cree_le: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=maintenant)


class LigneCommande(Base):
    __tablename__ = "lignes_commande"

    id: Mapped[int] = mapped_column(primary_key=True)
    commande_id: Mapped[int] = mapped_column(ForeignKey("commandes_cantine.id"), index=True)
    plat_id: Mapped[int | None] = mapped_column(ForeignKey("plats.id"), nullable=True)
    nom: Mapped[str] = mapped_column(String(80))
    prix: Mapped[int] = mapped_column(Integer)
    quantite: Mapped[int] = mapped_column(Integer)


class Journal(Base):
    __tablename__ = "journal_cartes"

    id: Mapped[int] = mapped_column(primary_key=True)
    carte_id: Mapped[int | None] = mapped_column(ForeignKey("cartes.id"), nullable=True)
    etudiant_id: Mapped[int | None] = mapped_column(ForeignKey("etudiants.id"), nullable=True, index=True)
    utilisateur_id: Mapped[int | None] = mapped_column(ForeignKey("utilisateurs.id"), nullable=True)
    action: Mapped[str] = mapped_column(String(40))
    details: Mapped[str] = mapped_column(String(500), default="")
    cree_le: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=maintenant)
