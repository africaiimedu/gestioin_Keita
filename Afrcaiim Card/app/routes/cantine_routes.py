"""Poste de la cuisinière : elle valide le QR, le compte de la carte est débité."""

from fastapi import APIRouter, Depends, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.deps import exiger_cuisiniere, get_db
from app.models import Etudiant, MouvementCantine, Utilisateur
from app.ui import render

router = APIRouter()


@router.get("/cantine")
def poste(
    request: Request,
    cuisiniere: Utilisateur = Depends(exiger_cuisiniere),
    db: Session = Depends(get_db),
):
    lignes = db.execute(
        select(MouvementCantine, Etudiant)
        .join(Etudiant, Etudiant.id == MouvementCantine.etudiant_id)
        .order_by(MouvementCantine.id.desc())
        .limit(12)
    ).all()
    return render(request, "cantine.html", user=cuisiniere, lignes=lignes)
