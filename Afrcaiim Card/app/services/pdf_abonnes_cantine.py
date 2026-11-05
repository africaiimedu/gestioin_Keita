"""Liste PDF des étudiants abonnés à la cantine."""

from __future__ import annotations

import io
from datetime import datetime

from reportlab.lib.colors import HexColor, white
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.platypus import Image as ImagePdf
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

from app.config import ROOT
from app.services.cantine import montant_abonnement_etudiant
from app.services.courrier import formater_francs
from app.services.ecoles import libelle_niveau
from app.services.pdf_carte import assurer_polices

VERT = HexColor("#004C22")
OR = HexColor("#FEAB00")
CREME = HexColor("#F4F1EA")
GRIS = HexColor("#5F6B66")
MARGE = 36


def _style(nom: str, **options) -> ParagraphStyle:
    base = {"fontName": "DejaVu", "fontSize": 8.5, "leading": 10.5, "textColor": HexColor("#1D2B24")}
    base.update(options)
    return ParagraphStyle(nom, **base)


def _texte(valeur) -> str:
    return (str(valeur or "")).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _pied(c, doc) -> None:
    c.saveState()
    c.setFont("DejaVu", 7.5)
    c.setFillColor(GRIS)
    c.drawString(MARGE, 20, "Université AFRICAIIM · Abonnés à la cantine")
    c.drawRightString(A4[0] - MARGE, 20, f"Page {doc.page}")
    c.setStrokeColor(OR)
    c.setLineWidth(1.2)
    c.line(MARGE, 30, A4[0] - MARGE, 30)
    c.restoreState()


def pdf_abonnes_cantine(etudiants) -> bytes:
    assurer_polices()
    tampon = io.BytesIO()
    doc = SimpleDocTemplate(
        tampon,
        pagesize=A4,
        leftMargin=MARGE,
        rightMargin=MARGE,
        topMargin=MARGE,
        bottomMargin=44,
        title="Abonnés à la cantine",
        author="Université AFRICAIIM",
    )
    titre = _style("titre", fontName="DejaVu-Bold", fontSize=16, leading=20, textColor=VERT)
    sous_titre = _style("sous", fontSize=9, leading=12, textColor=GRIS)
    cellule = _style("cellule")
    entete = _style("entete", fontName="DejaVu-Bold", textColor=white)
    resume = (
        f"{len(etudiants)} abonné{'s' if len(etudiants) != 1 else ''} · "
        f"édité le {datetime.now().strftime('%d/%m/%Y à %H:%M')}"
    )
    textes = [Paragraph("Abonnés à la cantine", titre), Paragraph(_texte(resume), sous_titre)]
    largeur = A4[0] - 2 * MARGE
    logo = ROOT / "static" / "marque.png"
    if logo.is_file():
        image = ImagePdf(str(logo))
        ratio = image.imageWidth / image.imageHeight if image.imageHeight else 1
        image.drawHeight = 34
        image.drawWidth = 34 * ratio
        place = image.drawWidth + 12
        bandeau = Table([[image, textes]], colWidths=[place, largeur - place], hAlign="LEFT")
    else:
        bandeau = Table([[textes]], colWidths=[largeur], hAlign="LEFT")
    bandeau.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (0, 0), 12),
    ]))
    colonnes = ["N°", "Nom", "Prénom", "Matricule", "École", "Niveau", "Mois", "Validité", "Montant"]
    donnees = [[Paragraph(nom, entete) for nom in colonnes]]
    for rang, etudiant in enumerate(etudiants, start=1):
        mois = int(getattr(etudiant, "abonnement_mois", 0) or 0)
        montant = montant_abonnement_etudiant(etudiant)
        fin = etudiant.abonnement_fin.strftime("%d/%m/%Y") if etudiant.abonnement_fin else "—"
        donnees.append([
            Paragraph(str(rang), cellule),
            Paragraph(_texte(etudiant.nom), cellule),
            Paragraph(_texte(etudiant.prenom), cellule),
            Paragraph(_texte(etudiant.matricule), cellule),
            Paragraph(_texte(etudiant.filiere), cellule),
            Paragraph(_texte(libelle_niveau(etudiant.niveau, programme=etudiant.programme or etudiant.filiere)), cellule),
            Paragraph(str(mois or "—"), cellule),
            Paragraph(fin, cellule),
            Paragraph(formater_francs(montant), cellule),
        ])
    if len(donnees) == 1:
        donnees.append([Paragraph("Aucun abonné en cours.", cellule)] + [""] * (len(colonnes) - 1))
    parts = [0.05, 0.12, 0.13, 0.13, 0.18, 0.12, 0.06, 0.10, 0.11]
    tableau = Table(donnees, colWidths=[largeur * p for p in parts], repeatRows=1)
    style = [
        ("BACKGROUND", (0, 0), (-1, 0), VERT),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ("LEFTPADDING", (0, 0), (-1, -1), 3),
        ("RIGHTPADDING", (0, 0), (-1, -1), 3),
        ("LINEBELOW", (0, 0), (-1, 0), 1.2, OR),
        ("LINEBELOW", (0, 1), (-1, -1), 0.25, HexColor("#D9D4C7")),
        ("ALIGN", (-1, 1), (-1, -1), "RIGHT"),
    ]
    for rang in range(2, len(donnees), 2):
        style.append(("BACKGROUND", (0, rang), (-1, rang), CREME))
    if len(etudiants) == 0:
        style.append(("SPAN", (0, 1), (-1, 1)))
    tableau.setStyle(TableStyle(style))
    doc.build([bandeau, Spacer(1, 12), tableau], onFirstPage=_pied, onLaterPages=_pied)
    return tampon.getvalue()
