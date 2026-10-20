"""Porte du relais d'impression. Seul un ordinateur muni de son jeton y entre."""

from __future__ import annotations

import base64

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse, Response
from sqlalchemy.orm import Session

from app.config import base_url
from app.deps import get_db
from app.models import BadgePersonnel, Carte, Etudiant, Personnel, PosteImpression
from app.services import relais
from app.services.limite import autoriser
from app.services.metier import carte_courante, journaliser, marquer_imprimee
from app.services.pdf_carte import charger_modele_personnel, pdf_feuille_a4, pdf_individuel
from app.services.photos import lire_photo, portrait_initiales
from app.services.statut import statut_effectif

router = APIRouter(prefix="/api/relais")


def _poste(request: Request, db: Session) -> PosteImpression | None:
    adresse = request.client.host if request.client else "0"
    if not autoriser(f"relais:{adresse}", 120, 60):
        return None
    entete = request.headers.get("authorization", "")
    jeton = entete[7:].strip() if entete[:7].lower() == "bearer " else ""
    return relais.poste_par_jeton(db, jeton)


def _interdit() -> JSONResponse:
    return JSONResponse({"ok": False, "message": "Jeton du relais refusé."}, status_code=401)


async def _corps(request: Request) -> dict:
    try:
        corps = await request.json()
    except ValueError:
        return {}
    return corps if isinstance(corps, dict) else {}


@router.post("/annonce")
async def annonce(request: Request, db: Session = Depends(get_db)):
    poste = _poste(request, db)
    if poste is None:
        return _interdit()
    corps = await _corps(request)
    liste = relais.annoncer(db, poste, corps.get("imprimantes"))
    return {"ok": True, "poste": poste.nom, "imprimantes": len(liste)}


def _pdf_du_travail(db: Session, travail) -> tuple[bytes | None, str]:
    if getattr(travail, "personnel_id", None):
        personne = db.get(Personnel, travail.personnel_id)
        badge = db.get(BadgePersonnel, travail.badge_id) if travail.badge_id else None
        if personne is None or badge is None or badge.personnel_id != personne.id:
            return None, "Ce badge a changé depuis la demande. Relancez l'impression."
        if statut_effectif(badge.statut, badge.date_validite) != "active":
            return None, "Ce badge n'est plus actif."
        photo = lire_photo(personne.photo_chemin) or portrait_initiales(personne.prenom, personne.nom)
        modele = charger_modele_personnel()
        if _sur_a4(travail):
            return (
                pdf_feuille_a4(
                    [(personne, photo, badge.jeton, badge.numero_edition)],
                    base_url(),
                    f"Badge {personne.numero}",
                    modele=modele,
                ),
                "",
            )
        return (
            pdf_individuel(
                personne, photo, badge.jeton, badge.numero_edition, base_url(),
                travail.recto_verso, retourner_verso=False, modele=modele,
            ),
            "",
        )

    etudiant = db.get(Etudiant, travail.etudiant_id) if travail.etudiant_id else None
    carte = carte_courante(db, etudiant.id) if etudiant else None
    if etudiant is None or carte is None or carte.id != travail.carte_id:
        return None, "Cette carte a changé depuis la demande. Relancez l'impression."
    if statut_effectif(carte.statut, carte.date_validite) != "active":
        return None, "Cette carte n'est plus active."
    photo = lire_photo(etudiant.photo_chemin)
    if photo is None:
        return None, "La photo de l'étudiant est introuvable."
    if _sur_a4(travail):
        element = (etudiant, photo, carte.jeton, carte.numero_edition)
        return pdf_feuille_a4([element], base_url(), f"Carte {etudiant.matricule}"), ""
    contenu = pdf_individuel(
        etudiant, photo, carte.jeton, carte.numero_edition, base_url(), travail.recto_verso, retourner_verso=False,
    )
    return contenu, ""


def _sur_a4(travail) -> bool:
    return travail.media == "A4"


@router.post("/travail")
def travail_suivant(request: Request, db: Session = Depends(get_db)):
    poste = _poste(request, db)
    if poste is None:
        return _interdit()
    for _ in range(5):
        travail = relais.prendre(db, poste)
        if travail is None:
            return Response(status_code=204)
        contenu, raison = _pdf_du_travail(db, travail)
        if contenu is None:
            relais.terminer(db, poste, travail.id, False, raison)
            continue
        return {
            "id": travail.id,
            "imprimante": travail.imprimante,
            "copies": travail.copies,
            "recto_verso": travail.recto_verso and not _sur_a4(travail),
            "sens": "portrait" if _sur_a4(travail) else travail.sens,
            "media": travail.media,
            "libelle": travail.libelle,
            "pdf": base64.b64encode(contenu).decode("ascii"),
        }
    return Response(status_code=204)


@router.post("/travail/{travail_id}")
async def travail_fini(travail_id: int, request: Request, db: Session = Depends(get_db)):
    poste = _poste(request, db)
    if poste is None:
        return _interdit()
    corps = await _corps(request)
    ok = bool(corps.get("ok"))
    travail = relais.terminer(db, poste, travail_id, ok, str(corps.get("message") or ""))
    if travail is None:
        return JSONResponse({"ok": False, "message": "Travail inconnu ou déjà terminé."}, status_code=404)
    face = "recto-verso, bord long" if travail.recto_verso else "recto seul"
    detail = f"{travail.imprimante} ({poste.nom}) · {travail.copies} copie(s) · {face} · {travail.sens}"
    if ok and travail.carte_id:
        carte = db.get(Carte, travail.carte_id)
        if carte is not None:
            marquer_imprimee(db, carte, travail.cree_par, detail)
    elif ok and getattr(travail, "badge_id", None):
        journaliser(db, "badge_imprime", utilisateur_id=travail.cree_par, details=detail[:500])
        db.commit()
    elif not ok:
        journaliser(
            db,
            "impression_relais",
            utilisateur_id=travail.cree_par,
            etudiant_id=travail.etudiant_id,
            details=f"Échec sur {travail.imprimante} ({poste.nom}) : {travail.message}"[:500],
        )
        db.commit()
    return {"ok": True}
