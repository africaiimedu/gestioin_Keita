"""Contrôle des cartes à l'entrée, pour le personnel de sécurité."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request
from sqlalchemy import or_, select
from sqlalchemy.orm import Session, selectinload

from app.deps import exiger_securite, get_db
from app.models import Etudiant, Utilisateur
from app.services.metier import courante_parmi
from app.services.statut import statut_effectif
from app.ui import render

router = APIRouter()


@router.get("/securite")
def controle(
    request: Request,
    q: str = "",
    agent: Utilisateur = Depends(exiger_securite),
    db: Session = Depends(get_db),
):
    texte = q.strip()[:80]
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
