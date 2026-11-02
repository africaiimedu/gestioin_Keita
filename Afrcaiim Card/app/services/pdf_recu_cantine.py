"""Reçu cantine en PDF, pour l'abonnement comme pour les repas."""

from __future__ import annotations

import io
from datetime import date, datetime

from reportlab.lib.colors import HexColor
from reportlab.lib.pagesizes import A5
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase.pdfmetrics import stringWidth
from reportlab.pdfgen import canvas as pdf_canvas

from app.config import ROOT
from app.services.courrier import formater_francs
from app.services.pdf_carte import assurer_polices
from app.services.recus import MODES, NATURES

VERT = HexColor("#004C22")
OR = HexColor("#FEAB00")
GRIS = HexColor("#5F6B66")
NOIR = HexColor("#1A1A1A")
MARGE = 28


def _quand(valeur) -> str:
    if isinstance(valeur, datetime):
        return valeur.strftime("%d/%m/%Y %H:%M")
    if isinstance(valeur, date):
        return valeur.strftime("%d/%m/%Y")
    return str(valeur or "")


def _couper(texte: str, police: str, taille: float, largeur: float) -> list[str]:
    mots = (texte or "").split()
    if not mots:
        return []
    lignes: list[str] = []
    courant = ""
    for mot in mots:
        essai = f"{courant} {mot}".strip()
        if stringWidth(essai, police, taille) <= largeur:
            courant = essai
        else:
            if courant:
                lignes.append(courant)
            courant = mot
    if courant:
        lignes.append(courant)
    return lignes


def pdf_recu_cantine(recu, agent=None) -> bytes:
    assurer_polices()
    tampon = io.BytesIO()
    c = pdf_canvas.Canvas(tampon, pagesize=A5)
    c.setTitle(f"Reçu {recu.numero}")
    c.setAuthor("Université AFRICAIIM")
    largeur, hauteur = A5
    milieu = largeur / 2
    y = hauteur - 36
    utile = largeur - 2 * MARGE

    logo = ROOT / "static" / "marque-identite.png"
    if logo.is_file():
        image = ImageReader(str(logo))
        iw, ih = image.getSize()
        lw = min(220, utile)
        lh = lw * (ih / iw) if iw else 50
        c.drawImage(image, milieu - lw / 2, y - lh, width=lw, height=lh, mask="auto", preserveAspectRatio=True)
        y -= lh + 14

    c.setFillColor(OR)
    c.setFont("DejaVu-Bold", 9)
    c.drawCentredString(milieu, y, "AFRICAIIM CANTINE")
    y -= 18
    c.setFillColor(VERT)
    c.setFont("DejaVu-Bold", 16)
    c.drawCentredString(milieu, y, f"Reçu {recu.numero}")
    y -= 16
    c.setFillColor(GRIS)
    c.setFont("DejaVu", 9)
    c.drawCentredString(milieu, y, _quand(recu.cree_le))
    y -= 14

    if recu.annule_le:
        c.setFillColor(HexColor("#C0392B"))
        c.setFont("DejaVu-Bold", 11)
        c.drawCentredString(milieu, y, f"ANNULÉ le {_quand(recu.annule_le)}")
        y -= 16

    c.setStrokeColor(OR)
    c.setLineWidth(1.5)
    c.line(MARGE, y, largeur - MARGE, y)
    y -= 18

    paires = [
        ("Étudiant", recu.nom_etudiant),
        ("Matricule", recu.matricule),
        ("Objet", NATURES.get(recu.nature, recu.nature)),
        ("Paiement", MODES.get(recu.mode, recu.mode)),
    ]
    c.setFont("DejaVu", 10)
    for libelle, valeur in paires:
        if not valeur:
            continue
        c.setFillColor(GRIS)
        c.drawString(MARGE, y, libelle)
        c.setFillColor(NOIR)
        c.drawRightString(largeur - MARGE, y, str(valeur)[:42])
        y -= 14

    details = (recu.details or "").strip()
    if details:
        y -= 6
        c.setFillColor(GRIS)
        c.setFont("DejaVu", 9)
        for ligne in _couper(details, "DejaVu", 9, utile):
            c.drawString(MARGE, y, ligne)
            y -= 12

    y -= 8
    c.setStrokeColor(HexColor("#D9D4C7"))
    c.setLineWidth(0.6)
    c.line(MARGE, y, largeur - MARGE, y)
    y -= 22
    libelle_montant = "Montant crédité" if recu.nature == "recharge" else "Montant payé"
    c.setFillColor(NOIR)
    c.setFont("DejaVu", 11)
    c.drawString(MARGE, y, libelle_montant)
    c.setFillColor(VERT)
    c.setFont("DejaVu-Bold", 14)
    c.drawRightString(largeur - MARGE, y, formater_francs(recu.montant))
    y -= 18
    if recu.solde_apres is not None:
        c.setFillColor(GRIS)
        c.setFont("DejaVu", 9)
        c.drawString(MARGE, y, "Solde après")
        c.drawRightString(largeur - MARGE, y, formater_francs(recu.solde_apres))
        y -= 14
    if agent is not None:
        c.setFillColor(GRIS)
        c.drawString(MARGE, y, "Validé par")
        c.setFillColor(NOIR)
        c.drawRightString(largeur - MARGE, y, getattr(agent, "identifiant", "") or "")
        y -= 14

    c.setFillColor(GRIS)
    c.setFont("DejaVu", 8)
    c.drawCentredString(milieu, 28, "Merci. Gardez ce reçu. Université AFRICAIIM")
    c.save()
    return tampon.getvalue()
