"""Données de démonstration pour tester la gestion cuisine en local."""

from __future__ import annotations

from datetime import date, timedelta
from decimal import Decimal

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.cuisine.models import (
    CuisineArticle,
    CuisineCaisse,
    CuisineDepense,
    CuisineEntree,
    CuisineFournisseur,
    CuisineRecetteLigne,
)
from app.config import base_url, env
from app.cuisine.service import enregistrer_achat, enregistrer_depense, enregistrer_entree, ouvrir_caisse
from app.models import CategoriePlat, Plat


def _demo_autorisee() -> bool:
    hote = base_url()
    return env("CUISINE_DEMO") == "1" or "127.0.0.1" in hote or "localhost" in hote


def assurer_demo(db: Session) -> None:
    if not _demo_autorisee():
        return
    if db.scalar(select(CuisineCaisse.id).limit(1)):
        return
    db.add(CuisineCaisse(nom="Caisse principale", type="especes"))
    db.add(CuisineCaisse(nom="Orange Money", type="orange_money"))
    db.flush()

    fournisseurs = [
        CuisineFournisseur(nom="Marché Madina", telephone="622000111", adresse="Madina, Conakry", produits="Riz, huile, légumes"),
        CuisineFournisseur(nom="Boucherie Kaloum", telephone="622000222", adresse="Kaloum", produits="Viande, poisson"),
        CuisineFournisseur(nom="Dépôt gaz Dixinn", telephone="622000333", adresse="Dixinn", produits="Gaz, charbon"),
    ]
    for f in fournisseurs:
        db.add(f)
    db.flush()

    articles = [
        ("RIZ-25", "Riz parfumé", "Ingrédients", "kg", "80", "12000", "10", fournisseurs[0].id),
        ("HUILE-20", "Huile végétale", "Épicerie", "litre", "40", "18000", "8", fournisseurs[0].id),
        ("VIANDE", "Viande de bœuf", "Viande", "kg", "25", "85000", "5", fournisseurs[1].id),
        ("OIGNON", "Oignons", "Légumes", "kg", "30", "8000", "5", fournisseurs[0].id),
        ("TOMATE", "Tomates", "Légumes", "kg", "18", "7000", "4", fournisseurs[0].id),
        ("POISSON", "Poisson frais", "Poisson", "kg", "12", "45000", "3", fournisseurs[1].id),
        ("EAU-15", "Eau 1,5 L", "Boissons", "bouteille", "120", "5000", "24", fournisseurs[0].id),
        ("GAZ", "Bouteille de gaz", "Autres", "pièce", "4", "150000", "1", fournisseurs[2].id),
    ]
    objets = {}
    for ref, nom, cat, unite, qte, cout, seuil, fid in articles:
        art = CuisineArticle(
            reference=ref, nom=nom, categorie=cat, unite=unite,
            quantite=Decimal(qte), cout_moyen=int(cout), seuil=Decimal(seuil),
            fournisseur_id=fid, description=f"Article de démo — {nom}",
        )
        db.add(art)
        objets[ref] = art
    db.flush()

    categorie = db.scalar(select(CategoriePlat).order_by(CategoriePlat.id))
    plat = db.scalar(select(Plat).where(Plat.nom.ilike("%riz%")))
    if plat is None and categorie:
        plat = Plat(
            categorie_id=categorie.id, nom="Riz sauce viande",
            description="Plat du jour de démonstration", prix=25000, visuel="bol",
        )
        db.add(plat)
        db.flush()
    if plat:
        for ref, qte in (("RIZ-25", "0.200"), ("VIANDE", "0.100"), ("HUILE-20", "0.050"), ("OIGNON", "0.040")):
            db.add(CuisineRecetteLigne(plat_id=plat.id, article_id=objets[ref].id, quantite=Decimal(qte)))
    db.commit()

    try:
        ouvrir_caisse(db, 2_000_000, None)
    except Exception:
        db.rollback()

    hier = (date.today() - timedelta(days=1)).isoformat()
    try:
        enregistrer_achat(db, {
            "date_achat": hier,
            "fournisseur_id": fournisseurs[0].id,
            "facture": "F-DEMO-001",
            "mode": "especes",
            "paye": 600000,
            "lignes": [{"article_id": objets["RIZ-25"].id, "quantite": "25", "prix_unitaire": 12000}],
        }, None)
    except Exception:
        db.rollback()
    try:
        enregistrer_depense(db, {
            "date_depense": date.today().isoformat(),
            "categorie": "Gaz",
            "description": "Recharge gaz cuisine",
            "montant": 150000,
            "mode": "especes",
            "responsable": "Cuisine",
        }, None)
    except Exception:
        db.rollback()
    if plat:
        try:
            enregistrer_entree(db, {
                "nature": "vente_plat",
                "plat_id": plat.id,
                "quantite_plats": 12,
                "mode": "especes",
                "description": "Ventes du midi (démo)",
            }, None)
        except Exception:
            db.rollback()
    assurer_simulation(db)


def assurer_simulation(db: Session) -> None:
    """Remplit 14 jours de ventes et de dépenses pour que les courbes du tableau de bord soient lisibles."""
    if not _demo_autorisee():
        return
    deja = db.scalar(
        select(func.count()).select_from(CuisineEntree).where(CuisineEntree.description.like("Simulation %"))
    ) or 0
    if deja >= 10:
        return
    plat = db.scalar(select(Plat).order_by(Plat.id))
    plats = list(db.scalars(select(Plat).order_by(Plat.nom).limit(4)).all())
    if not plats and plat:
        plats = [plat]
    if not plats:
        return
    aujourd = date.today()
    for i in range(13, 0, -1):
        jour = aujourd - timedelta(days=i)
        wd = jour.weekday()
        plat_j = plats[i % len(plats)]
        prix = int(plat_j.prix or 25000)
        if wd >= 5:
            portions = 6 + (i % 4)
        else:
            portions = 10 + wd * 3 + (i % 5)
        db.add(CuisineEntree(
            date_entree=jour,
            nature="vente_plat",
            description=f"Simulation {plat_j.nom} × {portions}",
            montant=prix * portions,
            mode="especes" if wd % 2 == 0 else "orange_money",
            plat_id=plat_j.id,
            quantite_plats=portions,
        ))
    depenses = [
        (13, "Gaz", "Recharge gaz (simulation)", 85000),
        (11, "Eau", "Facture d'eau (simulation)", 45000),
        (9, "Transport", "Approvisionnement marché (simulation)", 35000),
        (7, "Entretien", "Savon et hygiène (simulation)", 28000),
        (5, "Gaz", "Complément gaz (simulation)", 60000),
        (3, "Salaires", "Aide cuisine (simulation)", 120000),
        (1, "Eau", "Achat sachets d'eau (simulation)", 18000),
    ]
    for delta, cat, lib, montant in depenses:
        db.add(CuisineDepense(
            date_depense=aujourd - timedelta(days=delta),
            categorie=cat,
            description=lib,
            montant=montant,
            mode="especes",
            responsable="Cuisine",
        ))
    db.commit()
