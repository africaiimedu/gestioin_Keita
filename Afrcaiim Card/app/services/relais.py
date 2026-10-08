"""Relais d'impression : le site en ligne confie la carte à l'ordinateur du bureau.

Le relais (relais_impression.py) tourne sur l'ordinateur où les imprimantes sont branchées.
Il annonce ses imprimantes, vient chercher les travaux en attente, imprime avec CUPS
et renvoie le résultat. Le site ne contacte jamais l'ordinateur : c'est toujours le relais
qui appelle, avec son jeton secret.
"""

from __future__ import annotations

import hashlib
import json
import secrets
from datetime import timedelta

from sqlalchemy import select, update

from app.models import PosteImpression, TravailImpression, maintenant

EN_LIGNE = timedelta(seconds=90)
ATTENTE_MAX = timedelta(minutes=20)
SANS_REPONSE = timedelta(minutes=10)
LIBELLES = {
    "attente": "En attente du relais",
    "envoye": "Reçu par le relais",
    "imprime": "Imprimée",
    "erreur": "Erreur",
    "annule": "Annulée",
}


def _empreinte(jeton: str) -> str:
    return hashlib.sha256(jeton.encode()).hexdigest()


def creer_poste(db, nom: str, jeton: str | None = None) -> tuple[PosteImpression, str]:
    propre = (nom or "").strip()[:80]
    if len(propre) < 2:
        raise ValueError("Donnez un nom à cet ordinateur (ex. Mac du bureau).")
    secret = jeton or secrets.token_urlsafe(32)
    if len(secret) < 32:
        raise ValueError("Le jeton du relais doit contenir au moins 32 caractères.")
    poste = PosteImpression(nom=propre, jeton_hash=_empreinte(secret), imprimantes="[]", actif=True, cree_le=maintenant())
    db.add(poste)
    db.commit()
    return poste, secret


def poste_par_jeton(db, jeton: str) -> PosteImpression | None:
    if not jeton or len(jeton) < 32 or len(jeton) > 200:
        return None
    poste = db.scalar(select(PosteImpression).where(PosteImpression.jeton_hash == _empreinte(jeton)))
    if poste is None or not poste.actif:
        return None
    return poste


def _propres(imprimantes) -> list[dict]:
    if not isinstance(imprimantes, list):
        return []
    resultat = []
    for imp in imprimantes[:40]:
        if not isinstance(imp, dict):
            continue
        nom = str(imp.get("nom") or "").strip()
        if not nom or len(nom) > 200 or any(ord(c) < 32 for c in nom):
            continue
        etat = str(imp.get("etat") or "prête")[:20]
        resultat.append({"nom": nom, "etat": etat, "primacy": bool(imp.get("primacy"))})
    return resultat


def annoncer(db, poste: PosteImpression, imprimantes) -> list[dict]:
    liste = _propres(imprimantes)
    poste.imprimantes = json.dumps(liste, ensure_ascii=False)
    poste.vu_le = maintenant()
    db.commit()
    return liste


def _conscient(moment):
    if moment is not None and moment.tzinfo is None:
        from datetime import timezone

        return moment.replace(tzinfo=timezone.utc)
    return moment


def en_ligne(poste: PosteImpression) -> bool:
    vu = _conscient(poste.vu_le)
    return bool(poste.actif and vu and maintenant() - vu <= EN_LIGNE)


def imprimantes_de(poste: PosteImpression) -> list[dict]:
    try:
        return _propres(json.loads(poste.imprimantes or "[]"))
    except ValueError:
        return []


def postes(db) -> list[PosteImpression]:
    return list(db.scalars(select(PosteImpression).order_by(PosteImpression.id)).all())


def imprimantes_relais(db) -> list[dict]:
    """Imprimantes des ordinateurs du bureau en ligne. La clé désigne le poste et l'imprimante."""
    resultat = []
    for poste in postes(db):
        if not en_ligne(poste):
            continue
        for imp in imprimantes_de(poste):
            resultat.append({**imp, "cle": f"poste:{poste.id}:{imp['nom']}", "lieu": poste.nom, "poste_id": poste.id})
    return resultat


def mettre_en_file(
    db,
    poste_id: int,
    imprimante: str,
    *,
    etudiant_id: int | None,
    carte_id: int | None,
    libelle: str,
    copies: int,
    recto_verso: bool,
    sens: str,
    media: str,
    cree_par: int | None,
) -> TravailImpression:
    travail = TravailImpression(
        poste_id=poste_id,
        etudiant_id=etudiant_id,
        carte_id=carte_id,
        libelle=libelle[:200],
        imprimante=imprimante[:200],
        copies=max(1, min(20, int(copies))),
        recto_verso=bool(recto_verso),
        sens="portrait" if sens == "portrait" else "paysage",
        media=media[:40],
        statut="attente",
        message="",
        cree_par=cree_par,
        cree_le=maintenant(),
    )
    db.add(travail)
    db.commit()
    return travail


def _ranger(db) -> None:
    """Un travail trop ancien ne sort plus : personne n'attend une carte imprimée une heure plus tard."""
    instant = maintenant()
    db.execute(
        update(TravailImpression)
        .where(TravailImpression.statut == "attente", TravailImpression.cree_le < instant - ATTENTE_MAX)
        .values(statut="annule", message="Le relais n'a pas répondu à temps. Relancez l'impression.", fini_le=instant)
    )
    db.execute(
        update(TravailImpression)
        .where(TravailImpression.statut == "envoye", TravailImpression.pris_le < instant - SANS_REPONSE)
        .values(statut="erreur", message="Le relais n'a pas confirmé l'impression. Vérifiez l'imprimante.", fini_le=instant)
    )


def prendre(db, poste: PosteImpression) -> TravailImpression | None:
    """Le plus ancien travail en attente pour ce poste. Un seul relais le reçoit."""
    _ranger(db)
    travail = db.scalar(
        select(TravailImpression)
        .where(TravailImpression.poste_id == poste.id, TravailImpression.statut == "attente")
        .order_by(TravailImpression.id)
        .with_for_update(skip_locked=True)
        .limit(1)
    )
    poste.vu_le = maintenant()
    if travail is None:
        db.commit()
        return None
    travail.statut = "envoye"
    travail.pris_le = maintenant()
    db.commit()
    return travail


def terminer(db, poste: PosteImpression, travail_id: int, ok: bool, message: str) -> TravailImpression | None:
    travail = db.scalar(
        select(TravailImpression)
        .where(TravailImpression.id == travail_id, TravailImpression.poste_id == poste.id)
        .with_for_update()
    )
    if travail is None or travail.statut != "envoye":
        return None
    travail.statut = "imprime" if ok else "erreur"
    travail.message = (message or "")[:300]
    travail.fini_le = maintenant()
    db.commit()
    return travail


def derniers(db, limite: int = 12) -> list[TravailImpression]:
    _ranger(db)
    db.commit()
    return list(db.scalars(select(TravailImpression).order_by(TravailImpression.id.desc()).limit(limite)).all())


def revoquer(db, poste_id: int) -> None:
    poste = db.get(PosteImpression, poste_id)
    if poste is None:
        return
    poste.actif = False
    db.execute(
        update(TravailImpression)
        .where(TravailImpression.poste_id == poste.id, TravailImpression.statut == "attente")
        .values(statut="annule", message="Ordinateur retiré.", fini_le=maintenant())
    )
    db.commit()
