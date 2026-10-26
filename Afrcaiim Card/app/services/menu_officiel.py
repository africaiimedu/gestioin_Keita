"""Menu DiiMa de la cantine. Ne touche ni aux étudiants ni à leurs comptes."""

from __future__ import annotations

from sqlalchemy import select

from app.models import CategoriePlat, Plat
from app.services.menu_cantine import retirer_plat

CATEGORIES = (
    ("Petit-déjeuner", "petit-dej"),
    ("Déjeuner · Plat du jour", "plat-jour"),
    ("Formules économiques", "formules"),
)

PLATS = (
    ("petit-dej", "Pain omelette", "Pain et omelette, tous les jours.", 20000, "Tous les jours", "pain-omelette.jpg", 1),
    ("petit-dej", "Sandwich au thon", "Sandwich au thon, tous les jours.", 20000, "Tous les jours", "sandwich-thon.jpg", 2),
    ("petit-dej", "Sandwich au poulet", "Sandwich au poulet, tous les jours.", 20000, "Tous les jours", "sandwich-poulet.jpg", 3),
    ("petit-dej", "Sandwich à la viande", "Sandwich à la viande, tous les jours.", 20000, "Tous les jours", "sandwich-viande.jpg", 4),
    ("petit-dej", "Omelette seule", "Omelette à la carte.", 20000, "À la carte", "omelette-seule.jpg", 5),
    ("petit-dej", "Riz au lait seul", "Riz au lait à la carte.", 20000, "À la carte", "riz-lait.jpg", 6),
    (
        "plat-jour",
        "Riz ou fonio au poulet, sauce tomate et légumes",
        "Lundi · riz ou fonio, poulet, sauce tomate et légumes.",
        35000,
        "Lundi",
        "riz-fonio-poulet.jpg",
        1,
    ),
    (
        "plat-jour",
        "Riz ou fonio à la sauce arachide, bœuf et légumes",
        "Mardi · riz ou fonio, sauce arachide, bœuf et légumes.",
        35000,
        "Mardi",
        "riz-fonio-arachide.jpg",
        2,
    ),
    (
        "plat-jour",
        "Riz gras au poisson et légumes",
        "Mercredi · riz gras, poisson et légumes.",
        35000,
        "Mercredi",
        "riz-gras-poisson.jpg",
        3,
    ),
    (
        "plat-jour",
        "Riz à la sauce feuilles de patate",
        "Jeudi · riz et sauce feuilles de patate.",
        35000,
        "Jeudi",
        "riz-feuilles-patate.jpg",
        4,
    ),
    (
        "plat-jour",
        "Poulet yassa et crudités, avec riz ou couscous",
        "Vendredi · poulet yassa, crudités, riz ou couscous.",
        35000,
        "Vendredi",
        "poulet-yassa.jpg",
        5,
    ),
    (
        "plat-jour",
        "Riz à la sauce tomate, poisson et légumes",
        "Samedi · riz, sauce tomate, poisson et légumes.",
        35000,
        "Samedi",
        "riz-tomate-poisson.jpg",
        6,
    ),
    (
        "formules",
        "Pain omelette + boisson chaude",
        "Formule petit-déjeuner.",
        25000,
        "Formule",
        "formule-petit-dej.jpg",
        1,
    ),
    (
        "formules",
        "Riz + sauce + boisson",
        "Formule déjeuner.",
        40000,
        "Formule",
        "formule-dejeuner.jpg",
        2,
    ),
)


def appliquer_menu_diima(db, *, retirer_anciens: bool = False) -> None:
    """Met à jour uniquement catégories et plats. Aucune fiche étudiante n'est lue ni écrite."""
    par_slug: dict[str, CategoriePlat] = {}
    for ordre, (nom, slug) in enumerate(CATEGORIES, start=1):
        categorie = db.scalar(select(CategoriePlat).where(CategoriePlat.slug == slug))
        if categorie is None:
            categorie = CategoriePlat(nom=nom, slug=slug, ordre=ordre)
            db.add(categorie)
            db.flush()
        else:
            categorie.nom = nom
            categorie.ordre = ordre
        par_slug[slug] = categorie
    db.flush()

    gardes: set[str] = set()
    visuel = {"petit-dej": "frit", "plat-jour": "bol", "formules": "bol"}
    for slug, nom, description, prix, badge, fichier, ordre in PLATS:
        gardes.add(nom)
        plat = db.scalar(select(Plat).where(Plat.nom == nom))
        if plat is None:
            plat = Plat(nom=nom, categorie_id=par_slug[slug].id)
            db.add(plat)
        plat.categorie_id = par_slug[slug].id
        plat.description = description[:180]
        plat.prix = prix
        plat.prix_sans_solde = None
        plat.badge = badge
        plat.visuel = visuel[slug]
        plat.temps_min = 15
        plat.stock = None
        plat.disponible = True
        plat.ordre = ordre
        plat.photo_chemin = fichier
    db.flush()

    if retirer_anciens:
        ids = [plat.id for plat in db.scalars(select(Plat)).all() if plat.nom not in gardes]
        for plat_id in ids:
            retirer_plat(db, plat_id)
    db.commit()


if __name__ == "__main__":
    from app.database import SessionLocal
    from app.seed import verifier_base

    verifier_base()
    with SessionLocal() as db:
        appliquer_menu_diima(db, retirer_anciens=True)
    print("Menu DiiMa enregistré. Les fiches étudiants n'ont pas été modifiées.")
