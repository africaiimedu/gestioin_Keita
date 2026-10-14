"""Liste des étudiants en PDF (A4), avec les mêmes filtres que la page Étudiants."""

from __future__ import annotations

import io
from datetime import datetime

from reportlab.lib.colors import HexColor, white
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.platypus import Image as ImagePdf
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

from app.config import ROOT
from app.services.pdf_carte import assurer_polices
from app.services.statut import libelle_statut

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
    c.drawString(MARGE, 20, "Université AFRICAIIM · Liste des étudiants")
    c.drawRightString(A4[0] - MARGE, 20, f"Page {doc.page}")
    c.setStrokeColor(OR)
    c.setLineWidth(1.2)
    c.line(MARGE, 30, A4[0] - MARGE, 30)
    c.restoreState()


def pdf_liste_etudiants(lignes: list[dict], filtres: list[str]) -> bytes:
    """`lignes` : dictionnaires {etudiant, statut} comme sur la page Étudiants."""
    assurer_polices()
    tampon = io.BytesIO()
    doc = SimpleDocTemplate(
        tampon,
        pagesize=A4,
        leftMargin=MARGE,
        rightMargin=MARGE,
        topMargin=MARGE,
        bottomMargin=44,
        title="Liste des étudiants",
        author="Université AFRICAIIM",
    )

    titre = _style("titre", fontName="DejaVu-Bold", fontSize=16, leading=20, textColor=VERT)
    sous_titre = _style("sous", fontSize=9, leading=12, textColor=GRIS)
    cellule = _style("cellule")
    entete = _style("entete", fontName="DejaVu-Bold", textColor=white)

    resume = f"{len(lignes)} étudiant{'s' if len(lignes) > 1 else ''}"
    if filtres:
        resume += " · " + " · ".join(filtres)
    resume += f" · édité le {datetime.now().strftime('%d/%m/%Y à %H:%M')}"
    textes = [Paragraph("Liste des étudiants", titre), Paragraph(_texte(resume), sous_titre)]

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

    colonnes = ["N°", "Nom", "Prénom", "Matricule", "École", "Année", "Carte", "Photo"]
    donnees = [[Paragraph(nom, entete) for nom in colonnes]]
    for rang, ligne in enumerate(lignes, start=1):
        etudiant = ligne["etudiant"]
        statut = ligne.get("statut")
        donnees.append([
            Paragraph(str(rang), cellule),
            Paragraph(_texte(etudiant.nom), cellule),
            Paragraph(_texte(etudiant.prenom), cellule),
            Paragraph(_texte(etudiant.matricule), cellule),
            Paragraph(_texte(etudiant.filiere), cellule),
            Paragraph(_texte(etudiant.annee_academique), cellule),
            Paragraph(_texte(libelle_statut(statut) if statut else "Sans carte"), cellule),
            Paragraph("Oui" if etudiant.photo_chemin else "Non", cellule),
        ])
    if len(donnees) == 1:
        donnees.append([Paragraph("Aucun étudiant pour ce filtre.", cellule)] + [""] * (len(colonnes) - 1))

    parts = [0.05, 0.15, 0.17, 0.13, 0.22, 0.10, 0.11, 0.07]
    tableau = Table(donnees, colWidths=[largeur * p for p in parts], repeatRows=1)
    style = [
        ("BACKGROUND", (0, 0), (-1, 0), VERT),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ("LEFTPADDING", (0, 0), (-1, -1), 4),
        ("RIGHTPADDING", (0, 0), (-1, -1), 4),
        ("LINEBELOW", (0, 0), (-1, 0), 1.2, OR),
        ("LINEBELOW", (0, 1), (-1, -1), 0.25, HexColor("#D9D4C7")),
    ]
    for rang in range(2, len(donnees), 2):
        style.append(("BACKGROUND", (0, rang), (-1, rang), CREME))
    if len(lignes) == 0:
        style.append(("SPAN", (0, 1), (-1, 1)))
    tableau.setStyle(TableStyle(style))

    doc.build([bandeau, Spacer(1, 12), tableau], onFirstPage=_pied, onLaterPages=_pied)
    return tampon.getvalue()
