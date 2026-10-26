"""Page ouverte par le QR code : le scan suffit à confirmer l'étudiant, sans code à taper."""

from datetime import timedelta
from urllib.parse import quote
import re

from fastapi import APIRouter, Depends, Form, Request
from fastapi.responses import RedirectResponse, Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.deps import PERSONNEL, Redirection, get_db, utilisateur_courant
from app.services.comptes import doit_choisir_mot_de_passe
from app.models import BadgePersonnel, Carte, Journal
from app.services.cantine import decision_repas, prix_repas, valider_repas
from app.services.metier import journaliser, maintenant
from app.services.courrier import formater_francs
from app.services.limite import autoriser
from app.services.photos import lire_photo, portrait_initiales
from app.services.statut import statut_effectif
from app.ui import csrf_valide, flash, render

router = APIRouter()


def _sans_cache(reponse):
    reponse.headers["Cache-Control"] = "no-store"
    return reponse


def _meme_matricule(lien: str, carte: str) -> bool:
    def cle(valeur: str) -> str:
        return re.sub(r"\s+", "", str(valeur or "")).upper()
    return cle(lien) == cle(carte)


def _peut_pointer(agent) -> bool:
    return agent is not None and agent.role in ("securite", "scolarite", "admin")


def _deja_pointe(db: Session, agent_id: int, carte_id: int | None) -> bool:
    if not carte_id:
        return False
    dernier = db.scalar(
        select(Journal.cree_le)
        .where(
            Journal.action == "qr_valide",
            Journal.utilisateur_id == agent_id,
            Journal.carte_id == carte_id,
        )
        .order_by(Journal.cree_le.desc())
        .limit(1)
    )
    if dernier is None:
        return False
    actuel = maintenant()
    if dernier.tzinfo is None and actuel.tzinfo is not None:
        dernier = dernier.replace(tzinfo=actuel.tzinfo)
    return actuel - dernier < timedelta(seconds=120)


def _pointer_presence(db: Session, agent, carte: Carte | None, statut: str) -> bool:
    if not _peut_pointer(agent) or carte is None or statut != "active":
        return False
    if _deja_pointe(db, agent.id, carte.id):
        return True
    journaliser(
        db,
        "qr_valide",
        utilisateur_id=agent.id,
        etudiant_id=carte.etudiant_id,
        carte_id=carte.id,
        details=f"Présence · {agent.identifiant}",
    )
    db.commit()
    return True


@router.get("/verif/{matricule}")
def verifier(
    matricule: str,
    request: Request,
    t: str = "",
    db: Session = Depends(get_db),
):
    agent = utilisateur_courant(request, db)
    if agent is not None and agent.role not in PERSONNEL:
        if doit_choisir_mot_de_passe(agent):
            raise Redirection("/compte")
        raise Redirection("/menu")
    if agent is None:
        if t:
            raise Redirection(f"/login?suivant={quote(f'/verif/{matricule}?t={t}', safe='')}")
        raise Redirection("/menu")

    adresse = request.client.host if request.client else "0"
    if not autoriser(f"verif:{adresse}", 60, 60):
        return _sans_cache(render(request, "verif.html", mode="limite"))

    if not t:
        return _sans_cache(render(request, "verif.html", mode="scan"))

    # Seul le jeton secret compte : une carte imprimée avant un changement de matricule reste lisible.
    carte = db.scalar(select(Carte).where(Carte.jeton == t))
    if carte is not None:
        statut = statut_effectif(carte.statut, carte.date_validite)
        etudiant = carte.etudiant
        if not _meme_matricule(matricule, etudiant.matricule):
            return _sans_cache(render(request, "verif.html", mode="invalide"))
        prix = prix_repas()
        solde = int(etudiant.solde_cantine or 0)
        decision = decision_repas(solde, prix, etudiant.email or "", statut == "active")
        pointe = _pointer_presence(db, agent, carte, statut)
        return _sans_cache(
            render(
                request,
                "verif.html",
                mode="ok",
                nom=f"{etudiant.prenom} {etudiant.nom}",
                statut=statut,
                jeton=carte.jeton,
                matricule=etudiant.matricule,
                ecole=etudiant.filiere or "",
                programme=etudiant.programme or "",
                email=etudiant.email or "",
                solde=formater_francs(solde),
                prix=formater_francs(prix),
                peut=decision.ok,
                raison=decision.message,
                agent=agent is not None,
                autorise=agent is not None and (agent.role == "admin" or bool(agent.peut_valider_qr)),
                role=agent.role if agent else "",
                suivant=f"/verif/{quote(etudiant.matricule)}?t={quote(carte.jeton)}",
                personnel=False,
                pointe=pointe,
            )
        )

    badge = db.scalar(select(BadgePersonnel).where(BadgePersonnel.jeton == t))
    if badge is None:
        return _sans_cache(render(request, "verif.html", mode="invalide"))
    personne = badge.personnel
    if not _meme_matricule(matricule, personne.numero):
        return _sans_cache(render(request, "verif.html", mode="invalide"))
    statut = statut_effectif(badge.statut, badge.date_validite)
    pointe = _peut_pointer(agent) and statut == "active"
    return _sans_cache(
        render(
            request,
            "verif.html",
            mode="ok",
            nom=f"{personne.prenom} {personne.nom}",
            statut=statut,
            jeton=badge.jeton,
            matricule=personne.numero,
            ecole=personne.fonction or "",
            programme="",
            email=personne.email or "",
            solde="",
            prix="",
            peut=False,
            raison=f"Badge personnel · {personne.fonction}",
            agent=agent is not None,
            autorise=False,
            role=agent.role if agent else "",
            suivant=f"/verif/{quote(personne.numero)}?t={quote(badge.jeton)}",
            personnel=True,
            pointe=pointe,
        )
    )


@router.post("/verif/{matricule}/repas")
def valider_repas_carte(
    matricule: str,
    request: Request,
    t: str = Form(""),
    csrf: str = Form(""),
    db: Session = Depends(get_db),
):
    retour = f"/verif/{quote(matricule)}?t={quote(t)}"
    if not csrf_valide(request, csrf):
        flash(request, "erreur", "Formulaire expiré. Rechargez la page.")
        return RedirectResponse(retour, status_code=303)
    agent = utilisateur_courant(request, db)
    if agent is None or (agent.role != "admin" and not agent.peut_valider_qr):
        flash(request, "erreur", "Ce compte n'est pas autorisé à valider les QR codes.")
        return RedirectResponse(retour, status_code=303)
    if agent.role not in ("cuisiniere", "securite", "scolarite", "admin"):
        flash(request, "erreur", "Ce compte ne valide pas les QR codes.")
        return RedirectResponse(retour, status_code=303)
    adresse = request.client.host if request.client else "0"
    if not autoriser(f"repas:{adresse}", 30, 60):
        flash(request, "erreur", "Trop de validations. Réessayez dans une minute.")
        return RedirectResponse(retour, status_code=303)
    carte = db.scalar(select(Carte).where(Carte.jeton == t))
    if carte is None:
        flash(request, "erreur", "Ce QR code n'est pas valide.")
        return RedirectResponse(f"/verif/{quote(matricule)}", status_code=303)
    if statut_effectif(carte.statut, carte.date_validite) != "active":
        flash(request, "erreur", "Cette carte n'est pas valide.")
        return RedirectResponse(retour, status_code=303)
    if agent.role not in ("cuisiniere", "admin"):
        journaliser(
            db,
            "qr_valide",
            utilisateur_id=agent.id,
            etudiant_id=carte.etudiant_id,
            carte_id=carte.id,
            details=f"Contrôle par {agent.identifiant}",
        )
        db.commit()
        flash(request, "ok", f"Carte validée : {carte.etudiant.prenom} {carte.etudiant.nom}.")
        return RedirectResponse(retour, status_code=303)
    try:
        resultat = valider_repas(db, carte, agent.id)
    except ValueError as exc:
        flash(request, "erreur", str(exc))
        return RedirectResponse(retour, status_code=303)
    flash(
        request,
        "ok",
        f"Repas validé. Abonnement mensuel : aucun débit. Compte {formater_francs(resultat['solde'])}. Reçu {resultat['recu_numero']}.",
    )
    return RedirectResponse(f"/cantine/recus/{resultat['recu_id']}", status_code=303)


@router.get("/photo/{jeton}")
def photo_publique(jeton: str, request: Request, db: Session = Depends(get_db)):
    adresse = request.client.host if request.client else "0"
    if not autoriser(f"photo:{adresse}", 60, 60):
        return Response(status_code=429)
    if len(jeton) > 80:
        return Response(status_code=404)
    carte = db.scalar(select(Carte).where(Carte.jeton == jeton))
    if carte is None:
        return Response(status_code=404)
    blob = lire_photo(carte.etudiant.photo_chemin)
    if blob is None:
        blob = portrait_initiales(carte.etudiant.prenom, carte.etudiant.nom)
    return Response(blob, media_type="image/jpeg", headers={"Cache-Control": "no-store"})
