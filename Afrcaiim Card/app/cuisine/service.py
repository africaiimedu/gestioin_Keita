"""Calculs cuisine : CMP, caisse, rentabilité. Tout passe par le backend."""

from __future__ import annotations

from datetime import date, datetime, timedelta
from decimal import Decimal, ROUND_HALF_UP
from io import BytesIO

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.cuisine.models import (
    CuisineAchat,
    CuisineArticle,
    CuisineCaisse,
    CuisineDepense,
    CuisineEntree,
    CuisineFournisseur,
    CuisineInventaire,
    CuisineJournal,
    CuisineLigneAchat,
    CuisineLigneInventaire,
    CuisineMouvement,
    CuisineOperationCaisse,
    CuisinePerte,
    CuisineRecetteLigne,
    CuisineSessionCaisse,
)
from app.models import Plat, RecuCantine, maintenant

ZERO = Decimal("0")
UNITES = ["kg", "g", "litre", "ml", "sac", "carton", "bouteille", "pièce", "botte"]
CATEGORIES_ARTICLES = ["Ingrédients", "Épicerie", "Viande", "Poisson", "Légumes", "Boissons", "Emballages", "Autres"]
CATEGORIES_DEPENSES = [
    "Achat d'ingrédients", "Transport", "Gaz", "Charbon", "Électricité", "Eau",
    "Salaires", "Loyer", "Entretien", "Réparation", "Emballages", "Livraison",
    "Communication", "Autres dépenses",
]
NATURES_ENTREE = ["vente", "vente_plat", "recette_diverse", "apport_capital", "remboursement", "paiement_client"]
MODES = ["especes", "orange_money", "mobile_money", "banque", "credit"]
MOTIFS_PERTE = ["détérioré", "périmé", "gaspillé", "personnel", "offert", "écart_inventaire"]


class RefusCuisine(ValueError):
    pass


def _q(valeur) -> Decimal:
    return Decimal(str(valeur or 0)).quantize(Decimal("0.001"), rounding=ROUND_HALF_UP)


def _entier(valeur) -> int:
    return int(Decimal(str(valeur or 0)).quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def _periode(cle: str) -> tuple[date, date]:
    jour = date.today()
    if cle == "jour":
        return jour, jour
    if cle == "semaine":
        debut = jour - timedelta(days=jour.weekday())
        return debut, jour
    if cle == "annee":
        return date(jour.year, 1, 1), jour
    return date(jour.year, jour.month, 1), jour


def _journal(db: Session, action: str, details: str, agent_id: int | None) -> None:
    db.add(CuisineJournal(action=action, details=details[:2000], agent_id=agent_id))


def _session_ouverte(db: Session, caisse_id: int | None = None) -> CuisineSessionCaisse | None:
    req = select(CuisineSessionCaisse).where(CuisineSessionCaisse.fermee_le.is_(None))
    if caisse_id:
        req = req.where(CuisineSessionCaisse.caisse_id == caisse_id)
    return db.scalar(req.order_by(CuisineSessionCaisse.id.desc()))


def _caisse_defaut(db: Session) -> CuisineCaisse:
    caisse = db.scalar(select(CuisineCaisse).where(CuisineCaisse.actif.is_(True)).order_by(CuisineCaisse.id))
    if caisse is None:
        caisse = CuisineCaisse(nom="Caisse principale", type="especes")
        db.add(caisse)
        db.flush()
    return caisse


def _pousser_caisse(db: Session, sens: str, montant: int, libelle: str, piece: str, agent_id: int | None) -> None:
    if montant <= 0:
        return
    session = _session_ouverte(db)
    if session is None:
        return
    if sens == "sortie":
        session.solde_theorique -= montant
    else:
        session.solde_theorique += montant
    db.add(CuisineOperationCaisse(
        session_id=session.id, sens=sens, montant=montant, libelle=libelle, piece=piece,
    ))


def _numero(db: Session, prefixe: str, modele) -> str:
    jour = date.today().strftime("%Y%m%d")
    n = db.scalar(select(func.count()).select_from(modele).where(modele.numero.like(f"{prefixe}{jour}%"))) or 0
    return f"{prefixe}{jour}-{n + 1:03d}"


def valeur_article(article: CuisineArticle) -> int:
    return _entier(_q(article.quantite) * Decimal(article.cout_moyen))


def _entrer_stock(db: Session, article: CuisineArticle, quantite: Decimal, cout: int, type_mvt: str, motif: str, piece: str, agent_id: int | None) -> None:
    qte = _q(quantite)
    if qte <= 0:
        raise RefusCuisine("La quantité doit être positive.")
    ancien = _q(article.quantite)
    ancien_val = ancien * Decimal(article.cout_moyen)
    nouveau = ancien + qte
    if nouveau > 0:
        article.cout_moyen = _entier((ancien_val + qte * Decimal(cout)) / nouveau)
    article.quantite = nouveau
    db.add(CuisineMouvement(
        article_id=article.id, type=type_mvt, quantite=qte, cout_unitaire=cout,
        valeur=_entier(qte * Decimal(cout)), motif=motif, piece=piece, agent_id=agent_id,
    ))


def _sortir_stock(db: Session, article: CuisineArticle, quantite: Decimal, type_mvt: str, motif: str, piece: str, agent_id: int | None, autoriser_negatif: bool = False) -> int:
    qte = _q(quantite)
    if qte <= 0:
        raise RefusCuisine("La quantité doit être positive.")
    dispo = _q(article.quantite)
    if dispo < qte and not autoriser_negatif:
        raise RefusCuisine(f"Stock insuffisant pour {article.nom} ({dispo} {article.unite}).")
    article.quantite = dispo - qte
    valeur = _entier(qte * Decimal(article.cout_moyen))
    db.add(CuisineMouvement(
        article_id=article.id, type=type_mvt, quantite=-qte, cout_unitaire=article.cout_moyen,
        valeur=-valeur, motif=motif, piece=piece, agent_id=agent_id,
    ))
    return valeur


def cout_plat(db: Session, plat_id: int) -> int:
    total = 0
    for ligne in db.scalars(select(CuisineRecetteLigne).where(CuisineRecetteLigne.plat_id == plat_id)):
        article = db.get(CuisineArticle, ligne.article_id)
        if article:
            total += _entier(_q(ligne.quantite) * Decimal(article.cout_moyen))
    return total


def consommer_recette(db: Session, plat_id: int, portions: int, piece: str, agent_id: int | None) -> int:
    if portions < 1:
        raise RefusCuisine("Indiquez au moins une portion.")
    cout = 0
    lignes = db.scalars(select(CuisineRecetteLigne).where(CuisineRecetteLigne.plat_id == plat_id)).all()
    if not lignes:
        return 0
    for ligne in lignes:
        article = db.get(CuisineArticle, ligne.article_id)
        if article is None:
            continue
        cout += _sortir_stock(db, article, _q(ligne.quantite) * portions, "consommation", "Vente de plat", piece, agent_id)
    return cout


def enregistrer_achat(db: Session, donnees: dict, agent_id: int | None) -> CuisineAchat:
    lignes = donnees.get("lignes") or []
    if not lignes:
        raise RefusCuisine("Ajoutez au moins un produit à l'achat.")
    achat = CuisineAchat(
        numero=_numero(db, "ACH", CuisineAchat),
        facture=str(donnees.get("facture") or "")[:80],
        date_achat=date.fromisoformat(donnees["date_achat"]) if donnees.get("date_achat") else date.today(),
        fournisseur_id=donnees.get("fournisseur_id") or None,
        mode=str(donnees.get("mode") or "especes"),
        justificatif=str(donnees.get("justificatif") or "")[:200],
        agent_id=agent_id,
    )
    db.add(achat)
    db.flush()
    total = 0
    for brut in lignes:
        article = db.get(CuisineArticle, int(brut["article_id"]))
        if article is None or not article.actif:
            raise RefusCuisine("Produit introuvable.")
        qte = _q(brut["quantite"])
        pu = _entier(brut["prix_unitaire"])
        montant = _entier(qte * Decimal(pu))
        total += montant
        db.add(CuisineLigneAchat(achat_id=achat.id, article_id=article.id, quantite=qte, prix_unitaire=pu, montant=montant))
        _entrer_stock(db, article, qte, pu, "achat", f"Achat {achat.numero}", achat.numero, agent_id)
    achat.total = total
    paye = min(total, _entier(donnees.get("paye", total if achat.mode != "credit" else 0)))
    if achat.mode == "credit":
        paye = min(total, _entier(donnees.get("paye") or 0))
    achat.paye = paye
    if paye > 0:
        _pousser_caisse(db, "sortie", paye, f"Achat {achat.numero}", achat.numero, agent_id)
    _journal(db, "achat", f"{achat.numero} {total} GNF", agent_id)
    db.commit()
    db.refresh(achat)
    return achat


def payer_achat(db: Session, achat_id: int, montant: int, agent_id: int | None) -> CuisineAchat:
    achat = db.get(CuisineAchat, achat_id)
    if achat is None or achat.statut != "valide":
        raise RefusCuisine("Achat introuvable.")
    reste = achat.total - achat.paye
    paye = min(reste, _entier(montant))
    if paye <= 0:
        raise RefusCuisine("Rien à payer sur cet achat.")
    achat.paye += paye
    _pousser_caisse(db, "sortie", paye, f"Règlement {achat.numero}", achat.numero, agent_id)
    _journal(db, "paiement_achat", f"{achat.numero} +{paye}", agent_id)
    db.commit()
    db.refresh(achat)
    return achat


def enregistrer_depense(db: Session, donnees: dict, agent_id: int | None) -> CuisineDepense:
    categorie = str(donnees.get("categorie") or "")
    if categorie not in CATEGORIES_DEPENSES:
        raise RefusCuisine("Catégorie de dépense inconnue.")
    montant = _entier(donnees.get("montant"))
    if montant <= 0:
        raise RefusCuisine("Le montant doit être positif.")
    depense = CuisineDepense(
        date_depense=date.fromisoformat(donnees["date_depense"]) if donnees.get("date_depense") else date.today(),
        categorie=categorie,
        description=str(donnees.get("description") or "")[:240],
        montant=montant,
        mode=str(donnees.get("mode") or "especes"),
        responsable=str(donnees.get("responsable") or "")[:80],
        observation=str(donnees.get("observation") or "")[:240],
        agent_id=agent_id,
    )
    db.add(depense)
    db.flush()
    if depense.mode != "credit":
        _pousser_caisse(db, "sortie", montant, depense.description or depense.categorie, f"DEP-{depense.id}", agent_id)
    _journal(db, "depense", f"{categorie} {montant}", agent_id)
    db.commit()
    db.refresh(depense)
    return depense


def enregistrer_entree(db: Session, donnees: dict, agent_id: int | None) -> CuisineEntree:
    nature = str(donnees.get("nature") or "vente")
    if nature not in NATURES_ENTREE:
        raise RefusCuisine("Nature d'entrée inconnue.")
    montant = _entier(donnees.get("montant"))
    portions = int(donnees.get("quantite_plats") or 0)
    plat_id = int(donnees["plat_id"]) if donnees.get("plat_id") else None
    if nature == "vente_plat":
        if not plat_id:
            raise RefusCuisine("Choisissez le plat vendu.")
        plat = db.get(Plat, plat_id)
        if plat is None:
            raise RefusCuisine("Plat introuvable.")
        if portions < 1:
            portions = 1
        montant = plat.prix * portions
        consommer_recette(db, plat_id, portions, "vente", agent_id)
        if not str(donnees.get("description") or "").strip():
            donnees["description"] = plat.nom if portions == 1 else f"{plat.nom} × {portions}"
    elif montant <= 0:
        raise RefusCuisine("Le montant doit être positif.")
    entree = CuisineEntree(
        date_entree=date.fromisoformat(donnees["date_entree"]) if donnees.get("date_entree") else date.today(),
        nature=nature,
        description=str(donnees.get("description") or "")[:240],
        montant=montant,
        mode=str(donnees.get("mode") or "especes"),
        plat_id=plat_id,
        quantite_plats=portions,
        agent_id=agent_id,
    )
    db.add(entree)
    db.flush()
    if nature in {"vente", "vente_plat", "recette_diverse", "paiement_client"}:
        _pousser_caisse(db, "entree", montant, entree.description or nature, f"ENT-{entree.id}", agent_id)
    elif nature == "apport_capital":
        _pousser_caisse(db, "entree", montant, "Apport de capital", f"ENT-{entree.id}", agent_id)
    _journal(db, "entree", f"{nature} {montant}", agent_id)
    db.commit()
    db.refresh(entree)
    return entree


def enregistrer_perte(db: Session, donnees: dict, agent_id: int | None) -> CuisinePerte:
    article = db.get(CuisineArticle, int(donnees["article_id"]))
    if article is None:
        raise RefusCuisine("Produit introuvable.")
    qte = _q(donnees.get("quantite"))
    valeur = _sortir_stock(db, article, qte, "perte", str(donnees.get("motif") or "perte"), "perte", agent_id)
    perte = CuisinePerte(
        date_perte=date.fromisoformat(donnees["date_perte"]) if donnees.get("date_perte") else date.today(),
        article_id=article.id,
        motif=str(donnees.get("motif") or "gaspillé"),
        quantite=qte,
        valeur=valeur,
        observation=str(donnees.get("observation") or "")[:240],
        agent_id=agent_id,
    )
    db.add(perte)
    _journal(db, "perte", f"{article.nom} {qte}", agent_id)
    db.commit()
    db.refresh(perte)
    return perte


def poser_inventaire(db: Session, lignes: list[dict], observation: str, agent_id: int | None) -> CuisineInventaire:
    inventaire = CuisineInventaire(date_inventaire=date.today(), observation=observation[:240], agent_id=agent_id)
    db.add(inventaire)
    db.flush()
    for brut in lignes:
        article = db.get(CuisineArticle, int(brut["article_id"]))
        if article is None:
            continue
        physique = _q(brut.get("physique"))
        theorique = _q(article.quantite)
        ecart = physique - theorique
        valeur = 0
        if ecart > 0:
            _entrer_stock(db, article, ecart, article.cout_moyen, "inventaire", "Ajustement inventaire", f"INV-{inventaire.id}", agent_id)
        elif ecart < 0:
            valeur = _sortir_stock(db, article, -ecart, "inventaire", "Écart inventaire", f"INV-{inventaire.id}", agent_id)
        db.add(CuisineLigneInventaire(
            inventaire_id=inventaire.id, article_id=article.id,
            theorique=theorique, physique=physique, ecart=ecart, valeur_ecart=valeur,
        ))
    _journal(db, "inventaire", f"INV-{inventaire.id}", agent_id)
    db.commit()
    db.refresh(inventaire)
    return inventaire


def ouvrir_caisse(db: Session, solde: int, agent_id: int | None) -> CuisineSessionCaisse:
    if _session_ouverte(db):
        raise RefusCuisine("Une caisse est déjà ouverte.")
    caisse = _caisse_defaut(db)
    session = CuisineSessionCaisse(
        caisse_id=caisse.id, solde_ouverture=_entier(solde), solde_theorique=_entier(solde), agent_id=agent_id,
    )
    db.add(session)
    _journal(db, "caisse_ouverture", str(solde), agent_id)
    db.commit()
    db.refresh(session)
    return session


def cloturer_caisse(db: Session, solde_physique: int, agent_id: int | None) -> CuisineSessionCaisse:
    session = _session_ouverte(db)
    if session is None:
        raise RefusCuisine("Aucune caisse ouverte.")
    session.solde_physique = _entier(solde_physique)
    session.ecart = session.solde_physique - session.solde_theorique
    session.fermee_le = maintenant()
    _journal(db, "caisse_cloture", f"écart {session.ecart}", agent_id)
    db.commit()
    db.refresh(session)
    return session


def _somme(db: Session, modele, champ_date, champ_montant, debut: date, fin: date, **filtres) -> int:
    req = select(func.coalesce(func.sum(champ_montant), 0)).where(champ_date >= debut, champ_date <= fin)
    for cle, valeur in filtres.items():
        req = req.where(getattr(modele, cle) == valeur)
    return int(db.scalar(req) or 0)


def tableau(db: Session) -> dict:
    jour, semaine, mois = _periode("jour"), _periode("semaine"), _periode("mois")
    ventes = lambda d, f: (
        _somme(db, CuisineEntree, CuisineEntree.date_entree, CuisineEntree.montant, d, f, nature="vente")
        + _somme(db, CuisineEntree, CuisineEntree.date_entree, CuisineEntree.montant, d, f, nature="vente_plat")
        + int(db.scalar(
            select(func.coalesce(func.sum(RecuCantine.montant), 0)).where(
                RecuCantine.annule_le.is_(None),
                RecuCantine.nature.in_(("commande", "abonnement")),
                func.date(RecuCantine.cree_le) >= d,
                func.date(RecuCantine.cree_le) <= f,
            )
        ) or 0)
    )
    achats_tot = _somme(db, CuisineAchat, CuisineAchat.date_achat, CuisineAchat.total, date(2000, 1, 1), date.today())
    depenses = lambda d, f: _somme(db, CuisineDepense, CuisineDepense.date_depense, CuisineDepense.montant, d, f)
    recettes_enc = lambda d, f: _somme(db, CuisineEntree, CuisineEntree.date_entree, CuisineEntree.montant, d, f)
    conso = int(db.scalar(
        select(func.coalesce(func.sum(-CuisineMouvement.valeur), 0)).where(
            CuisineMouvement.type == "consommation",
            func.date(CuisineMouvement.cree_le) >= mois[0],
            func.date(CuisineMouvement.cree_le) <= mois[1],
        )
    ) or 0)
    pertes = int(db.scalar(
        select(func.coalesce(func.sum(CuisinePerte.valeur), 0)).where(CuisinePerte.statut == "valide")
    ) or 0)
    stock = 0
    for art in db.scalars(select(CuisineArticle).where(CuisineArticle.actif.is_(True))):
        stock += valeur_article(art)
    dettes = int(db.scalar(
        select(func.coalesce(func.sum(CuisineAchat.total - CuisineAchat.paye), 0)).where(CuisineAchat.statut == "valide")
    ) or 0)
    ca_mois = ventes(*mois)
    brut = ca_mois - conso
    charges = depenses(*mois)
    net = brut - charges
    session = _session_ouverte(db)
    return {
        "ca_jour": ventes(*jour),
        "ca_semaine": ventes(*semaine),
        "ca_mois": ca_mois,
        "achats": achats_tot,
        "depenses": charges,
        "recettes": recettes_enc(*mois),
        "sorties": depenses(*mois) + int(db.scalar(
            select(func.coalesce(func.sum(CuisineAchat.paye), 0)).where(
                CuisineAchat.date_achat >= mois[0], CuisineAchat.date_achat <= mois[1]
            )
        ) or 0),
        "solde_caisse": session.solde_theorique if session else 0,
        "caisse_ouverte": session is not None,
        "valeur_stock": stock,
        "consomme": conso,
        "benefice_brut": brut,
        "benefice_net": net,
        "marge": round((net / ca_mois) * 100, 1) if ca_mois else 0,
        "pertes": pertes,
        "dettes": dettes,
        "creances": 0,
        "seuil": charges,
        "alertes": [
            {"id": a.id, "nom": a.nom, "quantite": float(a.quantite), "unite": a.unite, "seuil": float(a.seuil)}
            for a in db.scalars(select(CuisineArticle).where(CuisineArticle.actif.is_(True)))
            if _q(a.quantite) <= _q(a.seuil)
        ],
    }


def series(db: Session) -> dict:
    jour = date.today()
    jours = [jour - timedelta(days=i) for i in range(13, -1, -1)]
    ca, dep, benef = [], [], []
    for j in jours:
        v = tableau_jour(db, j)
        ca.append({"date": j.isoformat(), "valeur": v["ca"]})
        dep.append({"date": j.isoformat(), "valeur": v["depenses"]})
        benef.append({"date": j.isoformat(), "valeur": v["net"]})
    cats = []
    for cat in CATEGORIES_DEPENSES:
        montant = _somme(db, CuisineDepense, CuisineDepense.date_depense, CuisineDepense.montant, *_periode("mois"), categorie=cat)
        if montant:
            cats.append({"categorie": cat, "valeur": montant})
    stock_hist = []
    for j in jours:
        stock_hist.append({"date": j.isoformat(), "valeur": tableau(db)["valeur_stock"]})
    return {"ca": ca, "depenses": dep, "benefices": benef, "depenses_cat": cats, "stock": stock_hist}


def tableau_jour(db: Session, jour: date) -> dict:
    ca = _somme(db, CuisineEntree, CuisineEntree.date_entree, CuisineEntree.montant, jour, jour, nature="vente")
    ca += _somme(db, CuisineEntree, CuisineEntree.date_entree, CuisineEntree.montant, jour, jour, nature="vente_plat")
    dep = _somme(db, CuisineDepense, CuisineDepense.date_depense, CuisineDepense.montant, jour, jour)
    conso = int(db.scalar(
        select(func.coalesce(func.sum(-CuisineMouvement.valeur), 0)).where(
            CuisineMouvement.type == "consommation", func.date(CuisineMouvement.cree_le) == jour,
        )
    ) or 0)
    return {"ca": ca, "depenses": dep, "conso": conso, "net": ca - conso - dep}


def exporter_excel(db: Session) -> bytes:
    from openpyxl import Workbook

    wb = Workbook()
    dash = tableau(db)
    feuille = wb.active
    feuille.title = "Tableau de bord"
    feuille.append(["Indicateur", "Montant GNF"])
    for cle, lib in [
        ("ca_jour", "CA jour"), ("ca_semaine", "CA semaine"), ("ca_mois", "CA mois"),
        ("achats", "Achats"), ("depenses", "Dépenses"), ("valeur_stock", "Valeur stock"),
        ("benefice_brut", "Bénéfice brut"), ("benefice_net", "Bénéfice net"), ("dettes", "Dettes"),
    ]:
        feuille.append([lib, dash[cle]])
    stock = wb.create_sheet("Stock")
    stock.append(["Référence", "Nom", "Qté", "Unité", "Coût moyen", "Valeur"])
    for art in db.scalars(select(CuisineArticle).order_by(CuisineArticle.nom)):
        stock.append([art.reference, art.nom, float(art.quantite), art.unite, art.cout_moyen, valeur_article(art)])
    tampon = BytesIO()
    wb.save(tampon)
    return tampon.getvalue()


def exporter_pdf(db: Session) -> bytes:
    from reportlab.lib.pagesizes import A4
    from reportlab.pdfgen.canvas import Canvas
    from app.services.pdf_carte import assurer_polices
    from app.services.courrier import formater_francs

    assurer_polices()
    dash = tableau(db)
    tampon = BytesIO()
    c = Canvas(tampon, pagesize=A4)
    c.setFont("DejaVu-Bold", 16)
    c.drawString(40, 800, "Rapport cuisine AFRICAIIM")
    c.setFont("DejaVu", 10)
    c.drawString(40, 782, date.today().strftime("%d/%m/%Y"))
    y = 750
    for lib, cle in [
        ("Chiffre d'affaires du mois", "ca_mois"),
        ("Dépenses du mois", "depenses"),
        ("Valeur du stock", "valeur_stock"),
        ("Marchandises consommées", "consomme"),
        ("Bénéfice brut", "benefice_brut"),
        ("Bénéfice net", "benefice_net"),
        ("Pertes", "pertes"),
        ("Dettes fournisseurs", "dettes"),
        ("Solde caisse", "solde_caisse"),
    ]:
        c.drawString(40, y, lib)
        c.drawRightString(540, y, formater_francs(dash[cle]))
        y -= 18
    c.save()
    return tampon.getvalue()


def article_public(article: CuisineArticle) -> dict:
    return {
        "id": article.id,
        "reference": article.reference,
        "nom": article.nom,
        "categorie": article.categorie,
        "description": article.description,
        "unite": article.unite,
        "quantite": float(article.quantite),
        "cout_moyen": article.cout_moyen,
        "prix_vente": article.prix_vente,
        "seuil": float(article.seuil),
        "peremption": article.peremption.isoformat() if article.peremption else "",
        "fournisseur_id": article.fournisseur_id,
        "valeur": valeur_article(article),
        "actif": article.actif,
        "alerte": _q(article.quantite) <= _q(article.seuil),
        "rupture": _q(article.quantite) <= 0,
    }
