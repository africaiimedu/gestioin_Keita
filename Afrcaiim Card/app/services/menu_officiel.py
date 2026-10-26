"""Menu DiiMa de la cantine, calqué sur la carte PDF. Ne touche ni aux étudiants ni à leurs comptes."""

from __future__ import annotations

from sqlalchemy import select

from app.models import CategoriePlat, Plat
from app.services.menu_cantine import retirer_plat

CATEGORIES = (
    ("Petit-déjeuner", "petit-dej"),
    ("Déjeuner · Plat du jour", "plat-jour"),
    ("Dîner · Plat du jour", "diner"),
    ("Formules économiques", "formules"),
    ("Boissons & suppléments", "extras"),
)

PLATS = (
    ("petit-dej", "Pain omelette", "Pain et omelette, tous les jours.", 20000, "Tous les jours", "pain-omelette.jpg", 1),
    ("petit-dej", "Sandwich au thon", "Sandwich au thon, tous les jours.", 20000, "Tous les jours", "sandwich-thon.jpg", 2),
    ("petit-dej", "Sandwich au poulet", "Sandwich au poulet, tous les jours.", 20000, "Tous les jours", "sandwich-poulet.jpg", 3),
    ("petit-dej", "Sandwich à la viande", "Sandwich à la viande, tous les jours.", 20000, "Tous les jours", "sandwich-viande.jpg", 4),
    ("petit-dej", "CHAWARMA", "CHAWARMA, tous les jours.", 20000, "Tous les jours", "chawarma.jpg", 5),
    ("petit-dej", "Omelette seule", "Omelette à la carte.", 20000, "À la carte", "omelette-seule.jpg", 6),
    ("petit-dej", "Riz au lait seul", "Riz au lait à la carte.", 10000, "À la carte", "riz-lait.jpg", 7),
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
        "diner",
        "Pilons de poulet ou poisson braisé, frites ou allocos, salade et attiéké",
        "Lundi · pilons de poulet ou poisson braisé, frites ou allocos, salade et attiéké.",
        50000,
        "Lundi",
        "diner-lundi.jpg",
        1,
    ),
    (
        "diner",
        "Spaghetti à la bolognaise ou aux fruits de mer",
        "Mardi · spaghetti à la bolognaise ou aux fruits de mer.",
        40000,
        "Mardi",
        "spaghetti-bolognaise.jpg",
        2,
    ),
    (
        "diner",
        "Vermicelles à la viande",
        "Mardi · vermicelles à la viande.",
        50000,
        "Mardi",
        "vermicelles-viande.jpg",
        3,
    ),
    (
        "diner",
        "Poisson ou poulet braisé, frites, allocos, salade et attiéké",
        "Mercredi · poisson ou poulet braisé, frites, allocos, salade et attiéké.",
        50000,
        "Mercredi",
        "diner-mercredi.jpg",
        4,
    ),
    (
        "diner",
        "Brochettes de viande, poisson ou de poulet, frites, allocos et salade",
        "Jeudi · brochettes de viande, poisson ou de poulet, frites, allocos et salade.",
        50000,
        "Jeudi",
        "brochettes-diner.jpg",
        5,
    ),
    (
        "diner",
        "Attiéké au poisson ou au poulet",
        "Vendredi · attiéké au poisson ou au poulet.",
        50000,
        "Vendredi",
        "attieke-diner.jpg",
        6,
    ),
    (
        "diner",
        "Fruits de mer accompagnés d'une salade composée",
        "Samedi · fruits de mer et salade composée.",
        50000,
        "Samedi",
        "fruits-mer.jpg",
        7,
    ),
    (
        "formules",
        "Pain omelette + boisson chaude",
        "Formule petit-déjeuner.",
        25000,
        "Petit-déjeuner",
        "formule-petit-dej.jpg",
        1,
    ),
    (
        "formules",
        "Riz + sauce + boisson",
        "Formule déjeuner.",
        40000,
        "Déjeuner",
        "formule-dejeuner.jpg",
        2,
    ),
    ("extras", "Eau minérale", "Une bouteille d'eau est recommandée à chaque repas.", 5000, "Boisson", "eau-minerale.jpg", 1),
    ("extras", "Jus naturel", "Jus naturel.", 10000, "Boisson", "jus-naturel.jpg", 2),
    ("extras", "Boisson gazeuse", "Boisson gazeuse.", 8000, "Boisson", "boisson-gazeuse.jpg", 3),
    ("extras", "Portion supplémentaire de riz", "Supplément.", 5000, "Supplément", "supplement-riz.jpg", 4),
    (
        "extras",
        "Frites ou allocos supplémentaires",
        "Supplément.",
        10000,
        "Supplément",
        "supplement-frites.jpg",
        5,
    ),
    (
        "extras",
        "Portion supplémentaire de viande ou poulet",
        "Supplément.",
        20000,
        "Supplément",
        "supplement-viande.jpg",
        6,
    ),
    (
        "extras",
        "Portion supplémentaire de poisson",
        "Supplément.",
        20000,
        "Supplément",
        "supplement-poisson.jpg",
        7,
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
    visuel = {
        "petit-dej": "frit",
        "plat-jour": "bol",
        "diner": "grill",
        "formules": "bol",
        "extras": "verre",
    }
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
