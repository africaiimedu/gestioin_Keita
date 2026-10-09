"""Page ouverte par le QR code : le personnel voit la validité de la carte, l'étudiant arrive sur le menu."""

from urllib.parse import quote

from fastapi import APIRouter, Depends, Form, Request
from fastapi.responses import RedirectResponse, Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.deps import PERSONNEL, Redirection, get_db, utilisateur_courant
from app.models import Carte
from app.services.cantine import decision_repas, prix_repas, valider_repas
from app.services.metier import journaliser
from app.services.courrier import formater_francs
from app.services.limite import autoriser
from app.services.photos import lire_photo, portrait_initiales
from app.services.pdf_carte import code_controle
from app.services.statut import statut_effectif
from app.ui import csrf_valide, flash, render

router = APIRouter()


def _sans_cache(reponse):
    reponse.headers["Cache-Control"] = "no-store"
    return reponse


@router.get("/verif/{matricule}")
def verifier(
    matricule: str,
    request: Request,
    t: str = "",
    db: Session = Depends(get_db),
):
    agent = utilisateur_courant(request, db)
    if agent is not None and agent.role not in PERSONNEL:
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
    if carte is None:
        return _sans_cache(render(request, "verif.html", mode="invalide"))

    statut = statut_effectif(carte.statut, carte.date_validite)
    etudiant = carte.etudiant
    prix = prix_repas()
    solde = int(etudiant.solde_cantine or 0)
    decision = decision_repas(solde, prix, etudiant.email or "", statut == "active")
    return _sans_cache(
        render(
            request,
            "verif.html",
            mode="ok",
            nom=f"{etudiant.prenom} {etudiant.nom}",
            statut=statut,
            jeton=carte.jeton,
            controle=code_controle(carte.jeton),
            matricule=etudiant.matricule,
            email=etudiant.email or "",
            solde=formater_francs(solde),
            prix=formater_francs(prix),
            peut=decision.ok,
            raison=decision.message,
            agent=agent is not None,
            autorise=agent is not None and (agent.role == "admin" or bool(agent.peut_valider_qr)),
            role=agent.role if agent else "",
            suivant=f"/verif/{quote(etudiant.matricule)}?t={quote(carte.jeton)}",
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
    if resultat["envoye"]:
        flash(
            request,
            "ok",
            f"Repas validé. Débit de {formater_francs(resultat['montant'])}. "
            f"E-mail envoyé à {resultat['email']}. Reste {formater_francs(resultat['solde'])}.",
        )
    else:
        flash(
            request,
            "ok",
            f"Repas validé. Débit de {formater_francs(resultat['montant'])}. "
            f"Reste {formater_francs(resultat['solde'])}. "
            f"L'e-mail pour {resultat['email']} est prêt, mais le serveur de messagerie n'est pas encore configuré.",
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
