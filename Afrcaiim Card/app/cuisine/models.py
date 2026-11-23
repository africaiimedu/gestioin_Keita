"""Tables du module cuisine (préfixe cuisine_). Indépendantes de la scolarité."""

from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import BigInteger, Boolean, Date, DateTime, ForeignKey, Integer, Numeric, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.models import maintenant

Qte = Numeric(14, 3)


class CuisineFournisseur(Base):
    __tablename__ = "cuisine_fournisseurs"

    id: Mapped[int] = mapped_column(primary_key=True)
    nom: Mapped[str] = mapped_column(String(120))
    telephone: Mapped[str] = mapped_column(String(40), default="")
    adresse: Mapped[str] = mapped_column(String(200), default="")
    produits: Mapped[str] = mapped_column(String(240), default="")
    actif: Mapped[bool] = mapped_column(Boolean, default=True)
    cree_le: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=maintenant)


class CuisineArticle(Base):
    __tablename__ = "cuisine_articles"

    id: Mapped[int] = mapped_column(primary_key=True)
    reference: Mapped[str] = mapped_column(String(40), unique=True, index=True)
    nom: Mapped[str] = mapped_column(String(120))
    categorie: Mapped[str] = mapped_column(String(60), default="Ingrédients")
    description: Mapped[str] = mapped_column(String(240), default="")
    unite: Mapped[str] = mapped_column(String(20), default="kg")
    quantite: Mapped[Decimal] = mapped_column(Qte, default=Decimal("0"))
    cout_moyen: Mapped[int] = mapped_column(BigInteger, default=0)
    prix_vente: Mapped[int] = mapped_column(BigInteger, default=0)
    seuil: Mapped[Decimal] = mapped_column(Qte, default=Decimal("0"))
    peremption: Mapped[date | None] = mapped_column(Date, nullable=True)
    fournisseur_id: Mapped[int | None] = mapped_column(ForeignKey("cuisine_fournisseurs.id"), nullable=True)
    actif: Mapped[bool] = mapped_column(Boolean, default=True)
    cree_le: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=maintenant)


class CuisineMouvement(Base):
    __tablename__ = "cuisine_mouvements"

    id: Mapped[int] = mapped_column(primary_key=True)
    article_id: Mapped[int] = mapped_column(ForeignKey("cuisine_articles.id"), index=True)
    type: Mapped[str] = mapped_column(String(24), index=True)
    quantite: Mapped[Decimal] = mapped_column(Qte)
    cout_unitaire: Mapped[int] = mapped_column(BigInteger, default=0)
    valeur: Mapped[int] = mapped_column(BigInteger, default=0)
    motif: Mapped[str] = mapped_column(String(200), default="")
    piece: Mapped[str] = mapped_column(String(80), default="")
    agent_id: Mapped[int | None] = mapped_column(ForeignKey("utilisateurs.id"), nullable=True)
    cree_le: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=maintenant, index=True)


class CuisineAchat(Base):
    __tablename__ = "cuisine_achats"

    id: Mapped[int] = mapped_column(primary_key=True)
    numero: Mapped[str] = mapped_column(String(24), unique=True)
    facture: Mapped[str] = mapped_column(String(80), default="")
    date_achat: Mapped[date] = mapped_column(Date, index=True)
    fournisseur_id: Mapped[int | None] = mapped_column(ForeignKey("cuisine_fournisseurs.id"), nullable=True)
    total: Mapped[int] = mapped_column(BigInteger, default=0)
    paye: Mapped[int] = mapped_column(BigInteger, default=0)
    mode: Mapped[str] = mapped_column(String(24), default="especes")
    justificatif: Mapped[str] = mapped_column(String(200), default="")
    statut: Mapped[str] = mapped_column(String(20), default="valide")
    agent_id: Mapped[int | None] = mapped_column(ForeignKey("utilisateurs.id"), nullable=True)
    cree_le: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=maintenant)


class CuisineLigneAchat(Base):
    __tablename__ = "cuisine_lignes_achat"

    id: Mapped[int] = mapped_column(primary_key=True)
    achat_id: Mapped[int] = mapped_column(ForeignKey("cuisine_achats.id"), index=True)
    article_id: Mapped[int] = mapped_column(ForeignKey("cuisine_articles.id"))
    quantite: Mapped[Decimal] = mapped_column(Qte)
    prix_unitaire: Mapped[int] = mapped_column(BigInteger)
    montant: Mapped[int] = mapped_column(BigInteger)


class CuisineDepense(Base):
    __tablename__ = "cuisine_depenses"

    id: Mapped[int] = mapped_column(primary_key=True)
    date_depense: Mapped[date] = mapped_column(Date, index=True)
    categorie: Mapped[str] = mapped_column(String(40), index=True)
    description: Mapped[str] = mapped_column(String(240), default="")
    montant: Mapped[int] = mapped_column(BigInteger)
    mode: Mapped[str] = mapped_column(String(24), default="especes")
    responsable: Mapped[str] = mapped_column(String(80), default="")
    observation: Mapped[str] = mapped_column(String(240), default="")
    justificatif: Mapped[str] = mapped_column(String(200), default="")
    achat_id: Mapped[int | None] = mapped_column(ForeignKey("cuisine_achats.id"), nullable=True)
    statut: Mapped[str] = mapped_column(String(20), default="valide")
    agent_id: Mapped[int | None] = mapped_column(ForeignKey("utilisateurs.id"), nullable=True)
    cree_le: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=maintenant)


class CuisineEntree(Base):
    __tablename__ = "cuisine_entrees"

    id: Mapped[int] = mapped_column(primary_key=True)
    date_entree: Mapped[date] = mapped_column(Date, index=True)
    nature: Mapped[str] = mapped_column(String(24), index=True)
    description: Mapped[str] = mapped_column(String(240), default="")
    montant: Mapped[int] = mapped_column(BigInteger)
    mode: Mapped[str] = mapped_column(String(24), default="especes")
    plat_id: Mapped[int | None] = mapped_column(ForeignKey("plats.id"), nullable=True)
    quantite_plats: Mapped[int] = mapped_column(Integer, default=0)
    statut: Mapped[str] = mapped_column(String(20), default="valide")
    agent_id: Mapped[int | None] = mapped_column(ForeignKey("utilisateurs.id"), nullable=True)
    cree_le: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=maintenant)


class CuisineRecetteLigne(Base):
    __tablename__ = "cuisine_recettes_lignes"

    id: Mapped[int] = mapped_column(primary_key=True)
    plat_id: Mapped[int] = mapped_column(ForeignKey("plats.id"), index=True)
    article_id: Mapped[int] = mapped_column(ForeignKey("cuisine_articles.id"))
    quantite: Mapped[Decimal] = mapped_column(Qte)


class CuisineCaisse(Base):
    __tablename__ = "cuisine_caisses"

    id: Mapped[int] = mapped_column(primary_key=True)
    nom: Mapped[str] = mapped_column(String(80), unique=True)
    type: Mapped[str] = mapped_column(String(24), default="especes")
    actif: Mapped[bool] = mapped_column(Boolean, default=True)


class CuisineSessionCaisse(Base):
    __tablename__ = "cuisine_sessions_caisse"

    id: Mapped[int] = mapped_column(primary_key=True)
    caisse_id: Mapped[int] = mapped_column(ForeignKey("cuisine_caisses.id"), index=True)
    ouverte_le: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=maintenant)
    fermee_le: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    solde_ouverture: Mapped[int] = mapped_column(BigInteger, default=0)
    solde_theorique: Mapped[int] = mapped_column(BigInteger, default=0)
    solde_physique: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    ecart: Mapped[int] = mapped_column(BigInteger, default=0)
    agent_id: Mapped[int | None] = mapped_column(ForeignKey("utilisateurs.id"), nullable=True)


class CuisineOperationCaisse(Base):
    __tablename__ = "cuisine_operations_caisse"

    id: Mapped[int] = mapped_column(primary_key=True)
    session_id: Mapped[int] = mapped_column(ForeignKey("cuisine_sessions_caisse.id"), index=True)
    sens: Mapped[str] = mapped_column(String(8))
    montant: Mapped[int] = mapped_column(BigInteger)
    libelle: Mapped[str] = mapped_column(String(200), default="")
    piece: Mapped[str] = mapped_column(String(80), default="")
    cree_le: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=maintenant)


class CuisinePerte(Base):
    __tablename__ = "cuisine_pertes"

    id: Mapped[int] = mapped_column(primary_key=True)
    date_perte: Mapped[date] = mapped_column(Date, index=True)
    article_id: Mapped[int] = mapped_column(ForeignKey("cuisine_articles.id"))
    motif: Mapped[str] = mapped_column(String(40))
    quantite: Mapped[Decimal] = mapped_column(Qte)
    valeur: Mapped[int] = mapped_column(BigInteger, default=0)
    observation: Mapped[str] = mapped_column(String(240), default="")
    statut: Mapped[str] = mapped_column(String(20), default="valide")
    agent_id: Mapped[int | None] = mapped_column(ForeignKey("utilisateurs.id"), nullable=True)
    cree_le: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=maintenant)


class CuisineInventaire(Base):
    __tablename__ = "cuisine_inventaires"

    id: Mapped[int] = mapped_column(primary_key=True)
    date_inventaire: Mapped[date] = mapped_column(Date)
    observation: Mapped[str] = mapped_column(String(240), default="")
    agent_id: Mapped[int | None] = mapped_column(ForeignKey("utilisateurs.id"), nullable=True)
    cree_le: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=maintenant)


class CuisineLigneInventaire(Base):
    __tablename__ = "cuisine_lignes_inventaire"

    id: Mapped[int] = mapped_column(primary_key=True)
    inventaire_id: Mapped[int] = mapped_column(ForeignKey("cuisine_inventaires.id"), index=True)
    article_id: Mapped[int] = mapped_column(ForeignKey("cuisine_articles.id"))
    theorique: Mapped[Decimal] = mapped_column(Qte)
    physique: Mapped[Decimal] = mapped_column(Qte)
    ecart: Mapped[Decimal] = mapped_column(Qte)
    valeur_ecart: Mapped[int] = mapped_column(BigInteger, default=0)


class CuisineJournal(Base):
    __tablename__ = "cuisine_journal"

    id: Mapped[int] = mapped_column(primary_key=True)
    action: Mapped[str] = mapped_column(String(40))
    details: Mapped[str] = mapped_column(Text, default="")
    agent_id: Mapped[int | None] = mapped_column(ForeignKey("utilisateurs.id"), nullable=True)
    cree_le: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=maintenant, index=True)
