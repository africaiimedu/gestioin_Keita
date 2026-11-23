"""API et page de la gestion cuisine (local)."""

from __future__ import annotations

import re
from datetime import date
from uuid import uuid4

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse, Response
from sqlalchemy import delete, func, select, update
from sqlalchemy.orm import Session

from app.cuisine.models import (
    CuisineAchat,
    CuisineArticle,
    CuisineDepense,
    CuisineEntree,
    CuisineFournisseur,
    CuisineJournal,
    CuisineLigneAchat,
    CuisineMouvement,
    CuisineOperationCaisse,
    CuisinePerte,
    CuisineRecetteLigne,
)
from app.cuisine.seed import assurer_demo, assurer_simulation
from app.cuisine.service import (
    CATEGORIES_ARTICLES,
    CATEGORIES_DEPENSES,
    MODES,
    MOTIFS_PERTE,
    NATURES_ENTREE,
    UNITES,
    RefusCuisine,
    article_public,
    cloturer_caisse,
    cout_plat,
    enregistrer_achat,
    enregistrer_depense,
    enregistrer_entree,
    enregistrer_perte,
    exporter_excel,
    exporter_pdf,
    ouvrir_caisse,
    payer_achat,
    poser_inventaire,
    series,
    tableau,
    _q,
    _session_ouverte,
)
from app.deps import exiger_cuisiniere, get_db
from app.models import CategoriePlat, LigneCommande, Plat, Utilisateur
from app.services.menu_cantine import RefusCommande, modifier_plat, retirer_plat
from app.ui import render

router = APIRouter()


def _json_erreur(exc: Exception, code: int = 400):
    return JSONResponse({"ok": False, "message": str(exc)}, status_code=code)


def _corps(request: Request) -> dict:
    return getattr(request.state, "_json", {}) or {}


@router.get("/cantine/gestion")
def page_gestion(request: Request, user: Utilisateur = Depends(exiger_cuisiniere), db: Session = Depends(get_db)):
    assurer_demo(db)
    assurer_simulation(db)
    return render(request, "cuisine_gestion.html", user=user)


def _constantes(user: Utilisateur) -> dict:
    return {
        "unites": UNITES,
        "categories_articles": CATEGORIES_ARTICLES,
        "categories_depenses": CATEGORIES_DEPENSES,
        "natures": NATURES_ENTREE,
        "modes": MODES,
        "motifs_perte": MOTIFS_PERTE,
        "role": user.role,
    }


@router.get("/cantine/gestion/api/constantes")
def api_constantes(user: Utilisateur = Depends(exiger_cuisiniere)):
    return _constantes(user)


@router.get("/cantine/gestion/api/refs")
def api_refs(user: Utilisateur = Depends(exiger_cuisiniere), db: Session = Depends(get_db)):
    return {
        "ok": True,
        **_constantes(user),
        "articles": api_stock(user, db)["articles"],
        "plats": api_plats(user, db)["plats"],
        "categories": api_categories(user, db)["categories"],
    }


@router.get("/cantine/gestion/api/tableau")
def api_tableau(user: Utilisateur = Depends(exiger_cuisiniere), db: Session = Depends(get_db)):
    assurer_demo(db)
    assurer_simulation(db)
    return {"ok": True, **tableau(db), "series": series(db)}


@router.get("/cantine/gestion/api/stock")
def api_stock(user: Utilisateur = Depends(exiger_cuisiniere), db: Session = Depends(get_db)):
    arts = db.scalars(select(CuisineArticle).where(CuisineArticle.actif.is_(True)).order_by(CuisineArticle.nom)).all()
    return {"ok": True, "articles": [article_public(a) for a in arts]}


@router.post("/cantine/gestion/api/stock")
async def api_creer_stock(request: Request, user: Utilisateur = Depends(exiger_cuisiniere), db: Session = Depends(get_db)):
    data = await request.json()
    nom = str(data.get("nom") or "").strip()
    if len(nom) < 2:
        return _json_erreur("Le nom du produit est obligatoire.")
    ref = str(data.get("reference") or "").strip().upper()
    if len(ref) < 2:
        base = re.sub(r"[^A-Z0-9]+", "-", nom.upper())[:18].strip("-") or "ART"
        ref = base
        if db.scalar(select(CuisineArticle.id).where(CuisineArticle.reference == ref)):
            ref = f"{base[:12]}-{uuid4().hex[:4].upper()}"
    elif db.scalar(select(CuisineArticle).where(CuisineArticle.reference == ref)):
        return _json_erreur("Cette référence existe déjà.")
    art = CuisineArticle(
        reference=ref, nom=nom,
        categorie=str(data.get("categorie") or "Ingrédients")[:60],
        description=str(data.get("description") or "")[:240],
        unite=str(data.get("unite") or "kg")[:20],
        quantite=_q(data.get("quantite") or 0),
        cout_moyen=int(data.get("cout_moyen") or 0),
        prix_vente=int(data.get("prix_vente") or 0),
        seuil=_q(data.get("seuil") or 0),
        fournisseur_id=int(data["fournisseur_id"]) if str(data.get("fournisseur_id") or "").isdigit() else None,
    )
    if data.get("peremption"):
        art.peremption = date.fromisoformat(data["peremption"])
    db.add(art)
    db.commit()
    return {"ok": True, "article": article_public(art)}


@router.post("/cantine/gestion/api/stock/{article_id}")
async def api_maj_stock(article_id: int, request: Request, user: Utilisateur = Depends(exiger_cuisiniere), db: Session = Depends(get_db)):
    art = db.get(CuisineArticle, article_id)
    if art is None:
        return _json_erreur("Produit introuvable.", 404)
    data = await request.json()
    for champ in ("nom", "categorie", "description", "unite"):
        if champ in data:
            setattr(art, champ, str(data[champ])[:240])
    if "seuil" in data:
        art.seuil = _q(data["seuil"])
    if "prix_vente" in data:
        art.prix_vente = int(data["prix_vente"] or 0)
    if "actif" in data:
        art.actif = bool(data["actif"])
    if data.get("peremption"):
        art.peremption = date.fromisoformat(data["peremption"])
    db.commit()
    return {"ok": True, "article": article_public(art)}


@router.post("/cantine/gestion/api/stock/supprimer")
async def api_supprimer_stock(request: Request, user: Utilisateur = Depends(exiger_cuisiniere), db: Session = Depends(get_db)):
    ids = [int(i) for i in (await request.json()).get("ids") or [] if str(i).isdigit() or isinstance(i, int)]
    if not ids:
        return _json_erreur("Cochez au moins un produit.")
    n = 0
    for art_id in ids:
        art = db.get(CuisineArticle, art_id)
        if art is None:
            continue
        db.execute(delete(CuisineRecetteLigne).where(CuisineRecetteLigne.article_id == art_id))
        art.actif = False
        n += 1
    db.commit()
    return {"ok": True, "nombre": n}


@router.post("/cantine/gestion/api/stock/{article_id}/mouvement")
async def api_mvt_stock(article_id: int, request: Request, user: Utilisateur = Depends(exiger_cuisiniere), db: Session = Depends(get_db)):
    from app.cuisine.service import _entrer_stock, _sortir_stock
    art = db.get(CuisineArticle, article_id)
    if art is None:
        return _json_erreur("Produit introuvable.", 404)
    data = await request.json()
    qte = _q(data.get("quantite"))
    try:
        if data.get("sens") == "entree":
            _entrer_stock(db, art, qte, int(data.get("cout") or art.cout_moyen), "ajustement", str(data.get("motif") or "Entrée"), "", user.id)
        else:
            _sortir_stock(db, art, qte, "sortie", str(data.get("motif") or "Sortie"), "", user.id)
        db.commit()
    except RefusCuisine as exc:
        db.rollback()
        return _json_erreur(exc)
    return {"ok": True, "article": article_public(art)}


@router.get("/cantine/gestion/api/stock/{article_id}/historique")
def api_hist_stock(article_id: int, user: Utilisateur = Depends(exiger_cuisiniere), db: Session = Depends(get_db)):
    mvts = db.scalars(select(CuisineMouvement).where(CuisineMouvement.article_id == article_id).order_by(CuisineMouvement.id.desc()).limit(80)).all()
    return {"ok": True, "mouvements": [
        {"id": m.id, "type": m.type, "quantite": float(m.quantite), "valeur": m.valeur, "motif": m.motif, "le": m.cree_le.isoformat()}
        for m in mvts
    ]}


@router.get("/cantine/gestion/api/fournisseurs")
def api_fournisseurs(user: Utilisateur = Depends(exiger_cuisiniere), db: Session = Depends(get_db)):
    liste = []
    for f in db.scalars(select(CuisineFournisseur).order_by(CuisineFournisseur.nom)):
        achats = db.scalars(select(CuisineAchat).where(CuisineAchat.fournisseur_id == f.id)).all()
        total = sum(a.total for a in achats)
        paye = sum(a.paye for a in achats)
        liste.append({
            "id": f.id, "nom": f.nom, "telephone": f.telephone, "adresse": f.adresse,
            "produits": f.produits, "actif": f.actif, "achete": total, "paye": paye, "dette": total - paye,
        })
    return {"ok": True, "fournisseurs": liste}


@router.post("/cantine/gestion/api/fournisseurs")
async def api_creer_fournisseur(request: Request, user: Utilisateur = Depends(exiger_cuisiniere), db: Session = Depends(get_db)):
    data = await request.json()
    nom = str(data.get("nom") or "").strip()
    if len(nom) < 2:
        return _json_erreur("Nom du fournisseur obligatoire.")
    f = CuisineFournisseur(
        nom=nom[:120], telephone=str(data.get("telephone") or "")[:40],
        adresse=str(data.get("adresse") or "")[:200], produits=str(data.get("produits") or "")[:240],
    )
    db.add(f)
    db.commit()
    return {"ok": True, "id": f.id}


@router.get("/cantine/gestion/api/achats")
def api_achats(user: Utilisateur = Depends(exiger_cuisiniere), db: Session = Depends(get_db)):
    liste = []
    for a in db.scalars(select(CuisineAchat).order_by(CuisineAchat.id.desc()).limit(100)):
        four = db.get(CuisineFournisseur, a.fournisseur_id) if a.fournisseur_id else None
        lignes = db.scalars(select(CuisineLigneAchat).where(CuisineLigneAchat.achat_id == a.id)).all()
        liste.append({
            "id": a.id, "numero": a.numero, "facture": a.facture, "date": a.date_achat.isoformat(),
            "fournisseur": four.nom if four else "—", "total": a.total, "paye": a.paye,
            "reste": a.total - a.paye, "mode": a.mode, "lignes": [
                {"article_id": l.article_id, "quantite": float(l.quantite), "prix_unitaire": l.prix_unitaire, "montant": l.montant}
                for l in lignes
            ],
        })
    return {"ok": True, "achats": liste}


@router.post("/cantine/gestion/api/achats")
async def api_creer_achat(request: Request, user: Utilisateur = Depends(exiger_cuisiniere), db: Session = Depends(get_db)):
    try:
        achat = enregistrer_achat(db, await request.json(), user.id)
    except RefusCuisine as exc:
        return _json_erreur(exc)
    return {"ok": True, "id": achat.id, "numero": achat.numero}


@router.post("/cantine/gestion/api/achats/{achat_id}/payer")
async def api_payer_achat(achat_id: int, request: Request, user: Utilisateur = Depends(exiger_cuisiniere), db: Session = Depends(get_db)):
    data = await request.json()
    try:
        achat = payer_achat(db, achat_id, int(data.get("montant") or 0), user.id)
    except RefusCuisine as exc:
        return _json_erreur(exc)
    return {"ok": True, "paye": achat.paye, "reste": achat.total - achat.paye}


@router.get("/cantine/gestion/api/depenses")
def api_depenses(user: Utilisateur = Depends(exiger_cuisiniere), db: Session = Depends(get_db)):
    rows = db.scalars(select(CuisineDepense).order_by(CuisineDepense.id.desc()).limit(150)).all()
    return {"ok": True, "depenses": [
        {"id": d.id, "date": d.date_depense.isoformat(), "categorie": d.categorie, "description": d.description,
         "montant": d.montant, "mode": d.mode, "responsable": d.responsable}
        for d in rows
    ]}


@router.post("/cantine/gestion/api/depenses")
async def api_creer_depense(request: Request, user: Utilisateur = Depends(exiger_cuisiniere), db: Session = Depends(get_db)):
    try:
        d = enregistrer_depense(db, await request.json(), user.id)
    except RefusCuisine as exc:
        return _json_erreur(exc)
    return {"ok": True, "id": d.id}


@router.get("/cantine/gestion/api/entrees")
def api_entrees(user: Utilisateur = Depends(exiger_cuisiniere), db: Session = Depends(get_db)):
    rows = db.scalars(select(CuisineEntree).order_by(CuisineEntree.id.desc()).limit(150)).all()
    entrees = []
    for e in rows:
        plat = db.get(Plat, e.plat_id) if e.plat_id else None
        nom_plat = plat.nom if plat else ""
        libelle = e.description or nom_plat or NATURES_ENTREE[0]
        if e.nature == "vente_plat":
            nature_affichee = nom_plat or e.description or "Vente"
            if e.quantite_plats and e.quantite_plats > 1 and nom_plat:
                nature_affichee = f"{nom_plat} × {e.quantite_plats}"
        else:
            nature_affichee = {"vente": "Vente", "recette_diverse": "Recette diverse", "apport_capital": "Apport de capital", "remboursement": "Remboursement", "paiement_client": "Paiement client"}.get(e.nature, e.nature)
        entrees.append({
            "id": e.id, "date": e.date_entree.isoformat(), "nature": e.nature,
            "nature_affichee": nature_affichee, "description": libelle, "plat_nom": nom_plat,
            "montant": e.montant, "mode": e.mode, "plat_id": e.plat_id, "quantite_plats": e.quantite_plats,
        })
    return {"ok": True, "entrees": entrees}


@router.post("/cantine/gestion/api/entrees")
async def api_creer_entree(request: Request, user: Utilisateur = Depends(exiger_cuisiniere), db: Session = Depends(get_db)):
    try:
        e = enregistrer_entree(db, await request.json(), user.id)
    except RefusCuisine as exc:
        db.rollback()
        return _json_erreur(exc)
    return {"ok": True, "id": e.id, "montant": e.montant}


@router.get("/cantine/gestion/api/plats")
def api_plats(user: Utilisateur = Depends(exiger_cuisiniere), db: Session = Depends(get_db)):
    sortie = []
    for plat in db.scalars(select(Plat).order_by(Plat.nom)):
        cout = cout_plat(db, plat.id)
        lignes = []
        for l in db.scalars(select(CuisineRecetteLigne).where(CuisineRecetteLigne.plat_id == plat.id)):
            art = db.get(CuisineArticle, l.article_id)
            lignes.append({"article_id": l.article_id, "nom": art.nom if art else "?", "quantite": float(l.quantite), "unite": art.unite if art else ""})
        marge = plat.prix - cout
        cat = db.get(CategoriePlat, plat.categorie_id)
        sortie.append({
            "id": plat.id, "nom": plat.nom, "description": plat.description, "prix": plat.prix,
            "categorie_id": plat.categorie_id, "categorie": cat.nom if cat else "",
            "disponible": plat.disponible,
            "cout": cout, "marge": marge, "pct": round((marge / plat.prix) * 100, 1) if plat.prix else 0,
            "lignes": lignes, "photo": plat.photo_chemin,
        })
    return {"ok": True, "plats": sortie}


@router.post("/cantine/gestion/api/plats")
async def api_creer_plat(request: Request, user: Utilisateur = Depends(exiger_cuisiniere), db: Session = Depends(get_db)):
    data = await request.json()
    nom = str(data.get("nom") or "").strip()
    prix = int(data.get("prix") or 0)
    if len(nom) < 2 or prix <= 0:
        return _json_erreur("Indiquez le nom du plat et un prix de vente.")
    cat = db.get(CategoriePlat, int(data["categorie_id"])) if str(data.get("categorie_id") or "").isdigit() else None
    if cat is None:
        cat = db.scalar(select(CategoriePlat).order_by(CategoriePlat.ordre, CategoriePlat.id))
    if cat is None:
        return _json_erreur("Aucune catégorie de plat n'est encore créée.")
    plat = Plat(
        categorie_id=cat.id, nom=nom[:80],
        description=str(data.get("description") or "")[:180],
        prix=prix, visuel="bol", disponible=True,
    )
    db.add(plat)
    db.commit()
    return {"ok": True, "id": plat.id, "nom": plat.nom, "prix": plat.prix}


@router.post("/cantine/gestion/api/plats/{plat_id}")
async def api_maj_plat(plat_id: int, request: Request, user: Utilisateur = Depends(exiger_cuisiniere), db: Session = Depends(get_db)):
    plat = db.get(Plat, plat_id)
    if plat is None:
        return _json_erreur("Plat introuvable.", 404)
    data = await request.json()
    try:
        modifier_plat(
            db, plat_id,
            str(data.get("nom") or plat.nom),
            str(data.get("description") if data.get("description") is not None else plat.description),
            int(data.get("prix") or plat.prix),
            int(data.get("categorie_id") or plat.categorie_id),
            bool(data["disponible"]) if "disponible" in data else plat.disponible,
            plat.prix_sans_solde,
        )
    except RefusCommande as exc:
        return _json_erreur(exc)
    return {"ok": True, "prix": db.get(Plat, plat_id).prix}


@router.post("/cantine/gestion/api/plats/supprimer")
async def api_supprimer_plats(request: Request, user: Utilisateur = Depends(exiger_cuisiniere), db: Session = Depends(get_db)):
    ids = [int(i) for i in (await request.json()).get("ids") or []]
    if not ids:
        return _json_erreur("Cochez au moins un plat.")
    noms = []
    try:
        for plat_id in ids:
            db.execute(delete(CuisineRecetteLigne).where(CuisineRecetteLigne.plat_id == plat_id))
            db.execute(update(CuisineEntree).where(CuisineEntree.plat_id == plat_id).values(plat_id=None))
            db.execute(update(LigneCommande).where(LigneCommande.plat_id == plat_id).values(plat_id=None))
            noms.append(retirer_plat(db, plat_id))
    except RefusCommande as exc:
        db.rollback()
        return _json_erreur(exc)
    return {"ok": True, "nombre": len(noms)}


@router.get("/cantine/gestion/api/categories")
def api_categories(user: Utilisateur = Depends(exiger_cuisiniere), db: Session = Depends(get_db)):
    liste = []
    for cat in db.scalars(select(CategoriePlat).order_by(CategoriePlat.ordre, CategoriePlat.nom)):
        n = db.scalar(select(func.count()).select_from(Plat).where(Plat.categorie_id == cat.id)) or 0
        liste.append({"id": cat.id, "nom": cat.nom, "plats": int(n)})
    return {"ok": True, "categories": liste}


@router.post("/cantine/gestion/api/categories")
async def api_creer_categorie(request: Request, user: Utilisateur = Depends(exiger_cuisiniere), db: Session = Depends(get_db)):
    nom = str((await request.json()).get("nom") or "").strip()
    if len(nom) < 2:
        return _json_erreur("Nom de catégorie obligatoire.")
    slug = re.sub(r"[^a-z0-9]+", "-", nom.lower()).strip("-")[:40] or "cat"
    if db.scalar(select(CategoriePlat).where(CategoriePlat.slug == slug)):
        slug = f"{slug[:32]}-{uuid4().hex[:4]}"
    ordre = int(db.scalar(select(func.max(CategoriePlat.ordre))) or 0) + 1
    cat = CategoriePlat(nom=nom[:40], slug=slug, ordre=ordre)
    db.add(cat)
    db.commit()
    return {"ok": True, "id": cat.id, "nom": cat.nom}


@router.post("/cantine/gestion/api/categories/supprimer")
async def api_supprimer_categories(request: Request, user: Utilisateur = Depends(exiger_cuisiniere), db: Session = Depends(get_db)):
    ids = [int(i) for i in (await request.json()).get("ids") or []]
    if not ids:
        return _json_erreur("Cochez au moins une catégorie.")
    if db.scalar(select(func.count()).select_from(CategoriePlat)) <= len(ids):
        return _json_erreur("Gardez au moins une catégorie.")
    reste = db.scalar(select(CategoriePlat).where(CategoriePlat.id.not_in(ids)).order_by(CategoriePlat.id))
    if reste is None:
        return _json_erreur("Impossible de tout supprimer.")
    plats = db.scalars(select(Plat).where(Plat.categorie_id.in_(ids))).all()
    try:
        for plat in plats:
            db.execute(delete(CuisineRecetteLigne).where(CuisineRecetteLigne.plat_id == plat.id))
            db.execute(update(CuisineEntree).where(CuisineEntree.plat_id == plat.id).values(plat_id=None))
            db.execute(update(LigneCommande).where(LigneCommande.plat_id == plat.id).values(plat_id=None))
            retirer_plat(db, plat.id)
        for cat_id in ids:
            cat = db.get(CategoriePlat, cat_id)
            if cat:
                db.delete(cat)
        db.commit()
    except RefusCommande as exc:
        db.rollback()
        return _json_erreur(exc)
    return {"ok": True, "nombre": len(ids)}


@router.post("/cantine/gestion/api/plats/{plat_id}/recette")
async def api_recette(plat_id: int, request: Request, user: Utilisateur = Depends(exiger_cuisiniere), db: Session = Depends(get_db)):
    plat = db.get(Plat, plat_id)
    if plat is None:
        return _json_erreur("Plat introuvable.", 404)
    data = await request.json()
    db.execute(delete(CuisineRecetteLigne).where(CuisineRecetteLigne.plat_id == plat_id))
    for l in data.get("lignes") or []:
        db.add(CuisineRecetteLigne(plat_id=plat_id, article_id=int(l["article_id"]), quantite=_q(l["quantite"])))
    db.commit()
    return {"ok": True, "cout": cout_plat(db, plat_id)}


@router.get("/cantine/gestion/api/caisse")
def api_caisse(user: Utilisateur = Depends(exiger_cuisiniere), db: Session = Depends(get_db)):
    session = _session_ouverte(db)
    ops = []
    if session:
        ops = db.scalars(select(CuisineOperationCaisse).where(CuisineOperationCaisse.session_id == session.id).order_by(CuisineOperationCaisse.id.desc()).limit(80)).all()
    return {
        "ok": True,
        "ouverte": session is not None,
        "solde_ouverture": session.solde_ouverture if session else 0,
        "solde_theorique": session.solde_theorique if session else 0,
        "operations": [{"id": o.id, "sens": o.sens, "montant": o.montant, "libelle": o.libelle, "le": o.cree_le.isoformat()} for o in ops],
    }


@router.post("/cantine/gestion/api/caisse/ouvrir")
async def api_ouvrir(request: Request, user: Utilisateur = Depends(exiger_cuisiniere), db: Session = Depends(get_db)):
    data = await request.json()
    try:
        s = ouvrir_caisse(db, int(data.get("solde") or 0), user.id)
    except RefusCuisine as exc:
        return _json_erreur(exc)
    return {"ok": True, "solde": s.solde_theorique}


@router.post("/cantine/gestion/api/caisse/cloturer")
async def api_cloturer(request: Request, user: Utilisateur = Depends(exiger_cuisiniere), db: Session = Depends(get_db)):
    data = await request.json()
    try:
        s = cloturer_caisse(db, int(data.get("solde_physique") or 0), user.id)
    except RefusCuisine as exc:
        return _json_erreur(exc)
    return {"ok": True, "ecart": s.ecart, "theorique": s.solde_theorique, "physique": s.solde_physique}


@router.get("/cantine/gestion/api/pertes")
def api_pertes(user: Utilisateur = Depends(exiger_cuisiniere), db: Session = Depends(get_db)):
    rows = db.scalars(select(CuisinePerte).order_by(CuisinePerte.id.desc()).limit(100)).all()
    return {"ok": True, "pertes": [
        {"id": p.id, "date": p.date_perte.isoformat(), "article_id": p.article_id, "motif": p.motif,
         "quantite": float(p.quantite), "valeur": p.valeur, "observation": p.observation}
        for p in rows
    ]}


@router.post("/cantine/gestion/api/pertes")
async def api_creer_perte(request: Request, user: Utilisateur = Depends(exiger_cuisiniere), db: Session = Depends(get_db)):
    try:
        p = enregistrer_perte(db, await request.json(), user.id)
    except RefusCuisine as exc:
        db.rollback()
        return _json_erreur(exc)
    return {"ok": True, "id": p.id, "valeur": p.valeur}


@router.post("/cantine/gestion/api/inventaire")
async def api_inventaire(request: Request, user: Utilisateur = Depends(exiger_cuisiniere), db: Session = Depends(get_db)):
    data = await request.json()
    try:
        inv = poser_inventaire(db, data.get("lignes") or [], str(data.get("observation") or ""), user.id)
    except RefusCuisine as exc:
        db.rollback()
        return _json_erreur(exc)
    return {"ok": True, "id": inv.id}


@router.get("/cantine/gestion/api/journal")
def api_journal(user: Utilisateur = Depends(exiger_cuisiniere), db: Session = Depends(get_db)):
    rows = db.scalars(select(CuisineJournal).order_by(CuisineJournal.id.desc()).limit(80)).all()
    return {"ok": True, "journal": [
        {"id": j.id, "action": j.action, "details": j.details, "le": j.cree_le.isoformat()} for j in rows
    ]}


@router.get("/cantine/gestion/api/export.xlsx")
def api_xlsx(user: Utilisateur = Depends(exiger_cuisiniere), db: Session = Depends(get_db)):
    return Response(
        exporter_excel(db),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": 'attachment; filename="rapport-cuisine.xlsx"'},
    )


@router.get("/cantine/gestion/api/export.pdf")
def api_pdf(user: Utilisateur = Depends(exiger_cuisiniere), db: Session = Depends(get_db)):
    return Response(
        exporter_pdf(db),
        media_type="application/pdf",
        headers={"Content-Disposition": 'attachment; filename="rapport-cuisine.pdf"'},
    )
