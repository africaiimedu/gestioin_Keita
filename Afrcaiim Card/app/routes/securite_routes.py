"""Contrôle des cartes à l'entrée et à la cantine, pour le personnel."""

from __future__ import annotations

import re
from urllib.parse import quote

from fastapi import APIRouter, Depends, Request
from sqlalchemy import or_, select
from sqlalchemy.orm import Session, selectinload

from app.deps import PERSONNEL, Redirection, exiger_securite, get_db, maison, utilisateur_courant
from app.models import BadgePersonnel, Carte, Etudiant, Utilisateur
from app.services.metier import courante_parmi
from app.services.pdf_carte import code_controle
from app.services.statut import statut_effectif
from app.ui import flash, render

router = APIRouter()

_CODE = re.compile(r"^[0-9A-F]{8}$")
_VERIF_LIEN = re.compile(
    r"/verif/([A-Za-z0-9-]{3,40})\?(?:[^#]*&)?t=([A-Za-z0-9_\-]{20,120})",
    re.I,
)
# Douchette réglée en QWERTY sur un poste AZERTY : les chiffres arrivent comme les symboles
# de la même touche (PC et Mac) et le A devient Q.
_AZERTY = str.maketrans({
    "&": "1", "é": "2", '"': "3", "'": "4", "(": "5", "-": "6", "§": "6",
    "è": "7", "_": "8", "!": "8", "ç": "9", "à": "0", "q": "a", "Q": "A",
})


def _candidats(saisie: str) -> list[str]:
    brut = (saisie or "").strip()
    codes = [re.sub(r"[^0-9A-Z]", "", brut.upper()), re.sub(r"[^0-9A-Z]", "", brut.translate(_AZERTY).upper())]
    return [code for code in dict.fromkeys(codes) if _CODE.match(code)]


def carte_par_code(db: Session, saisie: str) -> Carte | None:
    """Retrouve la carte dont le code de contrôle (imprimé et en code-barres) correspond."""
    candidats = _candidats(saisie)
    if not candidats:
        return None
    for carte in db.scalars(select(Carte).options(selectinload(Carte.etudiant))):
        if code_controle(carte.jeton).replace("-", "") in candidats:
            return carte
    return None


def _vers_verification(carte: Carte) -> str:
    return f"/verif/{quote(carte.etudiant.matricule)}?t={quote(carte.jeton)}"


def cible_depuis_scan(db: Session, saisie: str) -> str | None:
    """Le QR de la carte, un code-barres ou le code de contrôle ouvrent la même fiche."""
    texte = (saisie or "").strip()[:400]
    if not texte:
        return None
    match = _VERIF_LIEN.search(texte.replace("&amp;", "&"))
    if match:
        jeton = match.group(2)
        carte = db.scalar(select(Carte).options(selectinload(Carte.etudiant)).where(Carte.jeton == jeton))
        if carte is not None:
            return _vers_verification(carte)
        badge = db.scalar(
            select(BadgePersonnel)
            .options(selectinload(BadgePersonnel.personnel))
            .where(BadgePersonnel.jeton == jeton)
        )
        if badge is None:
            return None
        return f"/verif/{quote(badge.personnel.numero)}?t={quote(badge.jeton)}"
    carte = carte_par_code(db, texte)
    return _vers_verification(carte) if carte is not None else None


@router.get("/scan")
def scanner(request: Request, code: str = "", t: str = "", db: Session = Depends(get_db)):
    agent = utilisateur_courant(request, db)
    if agent is None:
        raise Redirection("/login")
    if agent.role not in PERSONNEL:
        raise Redirection("/menu")
    saisie = f"{code}?t={t}" if t and "t=" not in code else code
    cible = cible_depuis_scan(db, saisie)
    if cible is None:
        flash(request, "erreur", "QR ou code-barres inconnu : aucune carte ne correspond.")
        raise Redirection(maison(agent.role))
    raise Redirection(cible)


@router.get("/securite")
def controle(
    request: Request,
    q: str = "",
    t: str = "",
    agent: Utilisateur = Depends(exiger_securite),
    db: Session = Depends(get_db),
):
    texte = q.strip()[:400]
    if t and "t=" not in texte:
        texte = f"{texte}?t={t}"
    if texte:
        cible = cible_depuis_scan(db, texte)
        if cible is not None:
            raise Redirection(cible)
    lignes = []
    if texte and not _VERIF_LIEN.search(texte):
        motif = f"%{texte}%"
        etudiants = db.scalars(
            select(Etudiant)
            .options(selectinload(Etudiant.cartes))
            .where(
                or_(
                    Etudiant.matricule.ilike(motif),
                    Etudiant.nom.ilike(motif),
                    Etudiant.prenom.ilike(motif),
                )
            )
            .order_by(Etudiant.nom, Etudiant.prenom)
            .limit(20)
        ).all()
        for etudiant in etudiants:
            carte = courante_parmi(list(etudiant.cartes))
            lignes.append(
                {
                    "etudiant": etudiant,
                    "carte": carte,
                    "statut": statut_effectif(carte.statut, carte.date_validite) if carte else "",
                }
            )
    return render(request, "securite.html", user=agent, q=texte, lignes=lignes, cherche=bool(texte))
