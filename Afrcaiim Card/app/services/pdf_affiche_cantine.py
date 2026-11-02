"""Affiche A4 du QR menu cantine, à télécharger et à coller."""

from __future__ import annotations

import io

from reportlab.lib.colors import HexColor
from reportlab.lib.pagesizes import A4
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase.pdfmetrics import stringWidth
from reportlab.pdfgen import canvas as pdf_canvas

from app.config import ROOT
from app.services.pdf_carte import _dessiner_qr, assurer_polices

VERT = HexColor("#004C22")
OR = HexColor("#FEAB00")
GRIS = HexColor("#5F6B66")
NOIR = HexColor("#1A1A1A")
MARGE = 36


def _couper(texte: str, police: str, taille: float, largeur: float) -> list[str]:
    mots = (texte or "").split()
    if not mots:
        return [""]
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


def pdf_affiche_cantine(url: str, nom_point: str) -> bytes:
    assurer_polices()
    tampon = io.BytesIO()
    c = pdf_canvas.Canvas(tampon, pagesize=A4)
    c.setTitle("Affiche QR cantine")
    c.setAuthor("Université AFRICAIIM")
    largeur, hauteur = A4
    milieu = largeur / 2
    y = hauteur - 48

    logo = ROOT / "static" / "marque-identite.png"
    if logo.is_file():
        image = ImageReader(str(logo))
        iw, ih = image.getSize()
        lw = min(320, largeur - 2 * MARGE)
        lh = lw * (ih / iw) if iw else 80
        c.drawImage(image, milieu - lw / 2, y - lh, width=lw, height=lh, mask="auto", preserveAspectRatio=True)
        y -= lh + 18
    else:
        c.setFillColor(VERT)
        c.setFont("DejaVu-Bold", 18)
        c.drawCentredString(milieu, y - 8, "Université AFRICAIIM")
        y -= 36

    c.setStrokeColor(OR)
    c.setLineWidth(2)
    c.line(MARGE, y, largeur - MARGE, y)
    y -= 28

    c.setFillColor(OR)
    c.setFont("DejaVu-Bold", 11)
    c.drawCentredString(milieu, y, "CANTINE SCOLAIRE · UNIVERSITÉ AFRICAIIM")
    y -= 36

    c.setFillColor(VERT)
    c.setFont("DejaVu-Bold", 28)
    c.drawCentredString(milieu, y, "Scanne pour commander")
    y -= 28

    cote = 280
    y_qr = y - cote
    c.setFillColor(HexColor("#FFFFFF"))
    c.rect(milieu - cote / 2, y_qr, cote, cote, stroke=0, fill=1)
    _dessiner_qr(c, url, milieu - cote / 2, y_qr, cote, cote)
    y = y_qr - 26

    c.setFillColor(NOIR)
    c.setFont("DejaVu-Bold", 14)
    c.drawCentredString(milieu, y, nom_point or "Cantine")
    y -= 28

    aide = (
        "Ce QR code est définitif. Quand les repas changent, le même code affiche "
        "le nouveau menu. Le paiement se fait avec le compte de la carte."
    )
    c.setFillColor(GRIS)
    c.setFont("DejaVu", 11)
    for ligne in _couper(aide, "DejaVu", 11, largeur - 2 * MARGE - 40):
        c.drawCentredString(milieu, y, ligne)
        y -= 16

    c.setFillColor(GRIS)
    c.setFont("DejaVu", 8)
    c.drawCentredString(milieu, 28, "Université AFRICAIIM")
    c.save()
    return tampon.getvalue()
