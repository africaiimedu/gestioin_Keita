"""Contrôle des cartes à l'entrée et à la cantine, pour le personnel."""

from __future__ import annotations

import re
from urllib.parse import quote

from fastapi import APIRouter, Depends, Request
from sqlalchemy import or_, select
from sqlalchemy.orm import Session, selectinload

from app.deps import PERSONNEL, Redirection, exiger_securite, get_db, maison, utilisateur_courant
from app.models import Carte, Etudiant, Utilisateur
from app.services.metier import courante_parmi
from app.services.pdf_carte import code_controle
from app.services.statut import statut_effectif
from app.ui import flash, render

router = APIRouter()

_CODE = re.compile(r"^[0-9A-F]{8}$")
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


@router.get("/scan")
def scanner(request: Request, code: str = "", db: Session = Depends(get_db)):
    agent = utilisateur_courant(request, db)
    if agent is None:
        raise Redirection("/login")
    if agent.role not in PERSONNEL:
        raise Redirection("/menu")
    carte = carte_par_code(db, code[:40])
    if carte is None:
        flash(request, "erreur", "Code-barres inconnu : aucune carte ne porte ce code de contrôle.")
        raise Redirection(maison(agent.role))
    raise Redirection(_vers_verification(carte))


@router.get("/securite")
def controle(
    request: Request,
    q: str = "",
    agent: Utilisateur = Depends(exiger_securite),
    db: Session = Depends(get_db),
):
    texte = q.strip()[:80]
    if texte and _candidats(texte):
        carte = carte_par_code(db, texte)
        if carte is not None:
            raise Redirection(_vers_verification(carte))
    lignes = []
    if texte:
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
