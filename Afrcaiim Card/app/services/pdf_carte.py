"""PDF CR80 (85,6 × 54 mm) pour l'Evolis Primacy 2 : recto, puis verso."""

from __future__ import annotations

import hashlib
import io
import json
import math
from pathlib import Path
from urllib.parse import quote

import qrcode
from reportlab.lib.colors import Color, HexColor, white
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas as pdf_canvas

from app.config import ROOT, charger_config, chemin_logo, polices
from app.services.ecoles import niveau_sur_carte

MM = 72 / 25.4
# L'atelier affiche la carte à 7,4 px par mm. Le PDF reprend ces mêmes traits.
PX_ATELIER = 7.4
CARD_W = 85.6 * MM
CARD_H = 54 * MM


def taille_carte(modele: dict | None = None) -> tuple[float, float]:
    """CR80 paysage 85,6 × 54 mm, ou le même plastique tourné en portrait."""
    data = modele if modele is not None else charger_modele()
    if str((data or {}).get("orientation") or "paysage") == "portrait":
        return CARD_H, CARD_W
    return CARD_W, CARD_H


A4_W = 210 * MM
A4_H = 297 * MM

_polices_pretes = False


def mm(valeur: float) -> float:
    return valeur * MM


_FICHIERS_POLICE = {
    "DejaVu": "DejaVuSans.ttf",
    "DejaVu-Bold": "DejaVuSans-Bold.ttf",
    "DejaVu-Oblique": "DejaVuSans-Oblique.ttf",
    "DejaVu-BoldOblique": "DejaVuSans-BoldOblique.ttf",
    "DejaVuSerif": "DejaVuSerif.ttf",
    "DejaVuSerif-Bold": "DejaVuSerif-Bold.ttf",
    "DejaVuSerif-Italic": "DejaVuSerif-Italic.ttf",
    "DejaVuSerif-BoldItalic": "DejaVuSerif-BoldItalic.ttf",
}


def assurer_polices() -> None:
    global _polices_pretes
    if _polices_pretes:
        return
    dossier = ROOT / "fonts"
    for nom, fichier in _FICHIERS_POLICE.items():
        chemin = dossier / fichier
        if chemin.is_file():
            pdfmetrics.registerFont(TTFont(nom, str(chemin)))
    if "DejaVu" not in pdfmetrics.getRegisteredFontNames():
        regulier, gras = polices()
        pdfmetrics.registerFont(TTFont("DejaVu", str(regulier)))
        pdfmetrics.registerFont(TTFont("DejaVu-Bold", str(gras)))
    _polices_pretes = True


def _nom_police(obj: dict) -> str:
    famille = "serif" if obj.get("police") == "serif" else "sans"
    gras = bool(obj.get("gras"))
    italique = bool(obj.get("italique"))
    nom = {
        ("sans", False, False): "DejaVu",
        ("sans", True, False): "DejaVu-Bold",
        ("sans", False, True): "DejaVu-Oblique",
        ("sans", True, True): "DejaVu-BoldOblique",
        ("serif", False, False): "DejaVuSerif",
        ("serif", True, False): "DejaVuSerif-Bold",
        ("serif", False, True): "DejaVuSerif-Italic",
        ("serif", True, True): "DejaVuSerif-BoldItalic",
    }[(famille, gras, italique)]
    if nom not in pdfmetrics.getRegisteredFontNames():
        return "DejaVu-Bold" if gras else "DejaVu"
    return nom


def url_qr(base: str, matricule: str, jeton: str) -> str:
    """Adresse sans paramètre : beaucoup de téléphones ignorent « ?t= » au flash."""
    return f"{base.rstrip('/')}/id/{quote(str(jeton), safe='_-')}"


def url_affichee(base: str, matricule: str) -> str:
    propre = base.replace("https://", "").replace("http://", "").rstrip("/")
    return f"{propre}/verif/{matricule}"


def code_controle(jeton: str) -> str:
    """Code court imprimé sur la carte. Il ne révèle pas le jeton du QR."""
    brut = hashlib.sha256(f"Université AFRICAIIM:{jeton}".encode()).hexdigest()[:8].upper()
    return f"{brut[:4]}-{brut[4:]}"


def _charge_qr(obj: dict, etu, jeton: str, edition: int, base: str) -> str:
    """Le contenu « securise » est le seul QR qui ne peut pas être recopié."""
    contenu = str((obj or {}).get("contenu") or "securise")
    if contenu == "securise":
        return url_qr(base, etu.matricule, jeton)
    texte = _valeur_champ(contenu, etu, edition, base, jeton).strip()
    return texte or url_qr(base, etu.matricule, jeton)


def image_qr(url: str, encre: str = "#111111", fond: str = "#FFFFFF") -> bytes:
    code = qrcode.QRCode(
        error_correction=qrcode.constants.ERROR_CORRECT_H,
        box_size=8,
        border=2,
    )
    code.add_data(url)
    code.make(fit=True)
    image = code.make_image(fill_color=encre, back_color=fond).convert("RGB")
    sortie = io.BytesIO()
    image.save(sortie, format="PNG")
    return sortie.getvalue()


def _dessiner_qr(c, url: str, x, y, largeur, hauteur, encre="#111111") -> None:
    """Modules vectoriels : le QR reste net à 300 dpi, sans pixel flou."""
    code = qrcode.QRCode(error_correction=qrcode.constants.ERROR_CORRECT_H, border=2)
    code.add_data(url)
    code.make(fit=True)
    matrice = code.get_matrix()
    nombre = len(matrice)
    if nombre <= 0:
        return
    from reportlab.pdfgen.canvas import FILL_NON_ZERO

    cote = min(largeur, hauteur)
    # Chaque module tombe sur un nombre entier de points de la Primacy : sinon le noir se grise.
    pas_points = max(2, int((cote / nombre) / POINT_IMPRIMANTE))
    pas = pas_points * POINT_IMPRIMANTE
    cote_aligne = pas * nombre
    origine_x = round((x + (largeur - cote_aligne) / 2) / POINT_IMPRIMANTE) * POINT_IMPRIMANTE
    origine_y = round((y + (hauteur - cote_aligne) / 2) / POINT_IMPRIMANTE) * POINT_IMPRIMANTE
    debord = POINT_IMPRIMANTE
    chemin = c.beginPath()
    for ligne, rangee in enumerate(matrice):
        colonne = 0
        while colonne < nombre:
            if not rangee[colonne]:
                colonne += 1
                continue
            debut = colonne
            while colonne < nombre and rangee[colonne]:
                colonne += 1
            chemin.rect(
                origine_x + debut * pas,
                origine_y + (nombre - 1 - ligne) * pas,
                (colonne - debut) * pas + debord,
                pas + debord,
            )
    c.setFillColor(_encre(_hex(encre, "#111111")))
    c.drawPath(chemin, stroke=0, fill=1, fillMode=FILL_NON_ZERO)


def image_code128(valeur: str, encre: str = "#111111", fond: str = "#FFFFFF") -> bytes:
    """PNG net du code-barres, mêmes barres que le PDF."""
    from PIL import Image
    from reportlab.graphics.barcode.code128 import Code128

    propre = "".join(car if 32 <= ord(car) <= 126 else "-" for car in (valeur or "")) or "0"
    barre = Code128(propre, barWidth=1, quiet=0, humanReadable=0)
    barre._calculate()
    oa, oA = ord("a") - 1, ord("A") - 1
    modules: list[int] = []
    for car in barre.decomposed:
        code = ord(car)
        if car.islower():
            modules.extend([255] * (code - oa))
        elif car.isupper():
            modules.extend([0] * (code - oA))
    if not modules:
        modules = [255, 0, 255]
    quiet = [255] * 8
    ligne = quiet + modules + quiet
    bande = Image.new("L", (len(ligne), 1))
    bande.putdata(ligne)
    image = bande.resize((len(ligne) * 3, 90), Image.Resampling.NEAREST)
    noir = _hex(encre, "#111111")
    blanc = _hex(fond, "#FFFFFF")
    couleur = Image.new("RGB", image.size)
    couleur.putdata([
        (int(noir.red * 255), int(noir.green * 255), int(noir.blue * 255))
        if pixel < 128
        else (int(blanc.red * 255), int(blanc.green * 255), int(blanc.blue * 255))
        for pixel in image.get_flattened_data()
    ])
    sortie = io.BytesIO()
    couleur.save(sortie, format="PNG")
    return sortie.getvalue()


def positions_lot() -> list[tuple[float, float]]:
    """Huit cartes par feuille A4 : 2 colonnes × 4 lignes."""
    colonnes, lignes = 2, 4
    ecart_x, ecart_y = mm(8), mm(7)
    reserve_bas = mm(12)
    grille_w = colonnes * CARD_W + (colonnes - 1) * ecart_x
    grille_h = lignes * CARD_H + (lignes - 1) * ecart_y
    marge_x = (A4_W - grille_w) / 2
    marge_y = (A4_H - reserve_bas - grille_h) / 2
    slots = []
    for ligne in range(lignes):
        for colonne in range(colonnes):
            x = marge_x + colonne * (CARD_W + ecart_x)
            haut = A4_H - marge_y - ligne * (CARD_H + ecart_y)
            slots.append((x, haut - CARD_H))
    return slots


def _taille(c, texte: str, police: str, taille: float, largeur: float, approche: float = 0) -> float:
    while taille > 5.4 and _largeur_texte(c, texte, police, taille, approche) > largeur:
        taille -= 0.15
    return taille


def _largeur_texte(c, texte: str, police: str, taille: float, approche: float) -> float:
    if not texte:
        return 0
    return c.stringWidth(texte, police, taille) + approche * max(0, len(texte) - 1)


def _sur_grille(pt: float) -> float:
    return round(pt / POINT_IMPRIMANTE) * POINT_IMPRIMANTE


def _poser_glyphe(c, texte, x, y, police, taille, couleur, renforcer: bool = True) -> None:
    """Les petits textes reçoivent un trait de la même encre, pour que la résine K les tienne."""
    bloc = c.beginText()
    bloc.setTextOrigin(x, y)
    bloc.setFont(police, taille)
    bloc.setFillColor(couleur)
    if renforcer and taille <= 6.2:
        c.setStrokeColor(couleur)
        c.setLineWidth(POINT_IMPRIMANTE)
        c.setLineJoin(1)
        c.setLineCap(1)
        bloc.setStrokeColor(couleur)
        bloc.setTextRenderMode(2)
    bloc.textOut(texte)
    c.drawText(bloc)


def _ecrire_ligne(c, texte, x, baseline, police, taille, approche, souligne, couleur, renforcer: bool = True) -> float:
    x = _sur_grille(x)
    baseline = _sur_grille(baseline)
    c.setFillColor(couleur)
    c.setFont(police, taille)
    if approche:
        curseur = x
        for car in texte:
            _poser_glyphe(c, car, curseur, baseline, police, taille, couleur, renforcer)
            curseur += c.stringWidth(car, police, taille) + approche
        fin = curseur - approche
    else:
        _poser_glyphe(c, texte, x, baseline, police, taille, couleur, renforcer)
        fin = x + c.stringWidth(texte, police, taille)
    if souligne and texte:
        c.setStrokeColor(couleur)
        c.setLineWidth(max(POINT_IMPRIMANTE, taille * 0.06))
        trait = _sur_grille(baseline - taille * 0.15)
        c.line(x, trait, fin, trait)
    return fin - x


def _couper(c, texte, police, taille, largeur, approche=0) -> list[str]:
    lignes: list[str] = []
    courante = ""
    limite = max(largeur, 4)
    for mot in texte.split():
        essai = mot if not courante else f"{courante} {mot}"
        if _largeur_texte(c, essai, police, taille, approche) <= limite:
            courante = essai
        else:
            if courante:
                lignes.append(courante)
            courante = mot
    if courante:
        lignes.append(courante)
    return lignes


def _paragraphe(c, texte, x, y, police, taille, largeur, interligne, couleur, centre=False, align="left", approche=0, souligne=False):
    lignes = _couper(c, texte, police, taille, largeur, approche)
    for index, ligne in enumerate(lignes):
        yy = y - index * interligne
        if centre or align == "center":
            depart = x if centre else x + (largeur - _largeur_texte(c, ligne, police, taille, approche)) / 2
            if centre:
                depart = x - _largeur_texte(c, ligne, police, taille, approche) / 2
        elif align == "right":
            depart = x + largeur - _largeur_texte(c, ligne, police, taille, approche)
        elif align == "justify" and index < len(lignes) - 1 and " " in ligne:
            mots_ligne = ligne.split()
            largeur_mots = sum(c.stringWidth(mot, police, taille) for mot in mots_ligne)
            trous = max(1, len(mots_ligne) - 1)
            espace = (largeur - largeur_mots) / trous
            curseur = x
            for mot_index, mot in enumerate(mots_ligne):
                _ecrire_ligne(c, mot, curseur, yy, police, taille, approche, souligne and mot_index == 0, couleur)
                curseur += c.stringWidth(mot, police, taille) + espace
            continue
        else:
            depart = x
        _ecrire_ligne(c, ligne, depart, yy, police, taille, approche, souligne, couleur)
    return len(lignes)


def dessiner_recto(c, etu, photo: bytes, cfg: dict) -> None:
    couleurs = cfg["couleurs"]
    vert = HexColor(couleurs["vert"])
    or_couleur = HexColor(couleurs["or"])
    creme = HexColor(couleurs["creme"])
    gris = HexColor(couleurs["gris"])
    blanc = HexColor(couleurs["blanc"])
    w, h = CARD_W, CARD_H

    c.setFillColor(creme)
    c.rect(0, 0, w, h, fill=1, stroke=0)
    c.setFillColor(vert)
    c.rect(0, h - mm(17), w, mm(17), fill=1, stroke=0)
    c.setFillColor(or_couleur)
    c.rect(0, h - mm(17.8), w, mm(0.8), fill=1, stroke=0)
    c.rect(0, 0, mm(1.7), h, fill=1, stroke=0)

    texte_x = mm(4.2)
    logo = chemin_logo(cfg)
    if logo:
        c.drawImage(
            str(logo),
            mm(3.4),
            h - mm(15.6),
            width=mm(11),
            height=mm(11),
            preserveAspectRatio=True,
            mask="auto",
        )
        texte_x = mm(16)

    c.setFillColor(blanc)
    c.setFont("DejaVu", 6.5)
    c.drawString(texte_x, h - mm(5), cfg["universite"].upper())
    c.setFont("DejaVu-Bold", 12.5)
    africa = "AFRICA"
    c.drawString(texte_x, h - mm(10.2), africa)
    c.setFillColor(or_couleur)
    c.drawString(texte_x + c.stringWidth(africa, "DejaVu-Bold", 12.5), h - mm(10.2), "IIM")
    c.setFillColor(Color(1, 1, 1, alpha=0.9))
    c.setFont("DejaVu", 5.4)
    c.drawString(texte_x, h - mm(14.3), cfg["institut"])
    c.setFillColor(blanc)
    c.setFont("DejaVu-Bold", 7.2)
    c.drawRightString(w - mm(3.5), h - mm(9.6), cfg["mention_recto"].upper())

    px, py, pw, ph = mm(4.2), mm(3.6), mm(22.5), mm(30)
    c.setFillColor(blanc)
    c.setStrokeColor(or_couleur)
    c.setLineWidth(1.1)
    c.roundRect(px - mm(0.5), py - mm(0.5), pw + mm(1), ph + mm(1), 2, fill=1, stroke=1)
    if photo:
        c.drawImage(ImageReader(io.BytesIO(photo)), px, py, pw, ph, preserveAspectRatio=True, mask="auto")
    else:
        c.setFillColor(HexColor(couleurs["gris_clair"]))
        c.rect(px, py, pw, ph, fill=1, stroke=0)

    tx = mm(30.2)
    largeur = w - tx - mm(3.2)
    c.setFillColor(or_couleur)
    c.setFont("DejaVu-Bold", 7)
    c.drawString(tx, mm(29.4), etu.matricule)

    c.setFillColor(vert)
    nom = etu.nom.upper()
    taille_nom = _taille(c, nom, "DejaVu-Bold", 11.5, largeur)
    c.setFont("DejaVu-Bold", taille_nom)
    c.drawString(tx, mm(23.6), nom)

    c.setFillColor(gris)
    taille_prenom = _taille(c, etu.prenom, "DejaVu", 9.5, largeur)
    c.setFont("DejaVu", taille_prenom)
    c.drawString(tx, mm(19.2), etu.prenom)

    c.setStrokeColor(or_couleur)
    c.setLineWidth(0.8)
    c.line(tx, mm(16.8), tx + mm(26), mm(16.8))

    c.setFillColor(gris)
    c.setFont("DejaVu", 5.6)
    c.drawString(tx, mm(13.6), "FILIÈRE")
    c.setFillColor(vert)
    taille_filiere = _taille(c, etu.filiere, "DejaVu-Bold", 8, largeur)
    c.setFont("DejaVu-Bold", taille_filiere)
    c.drawString(tx, mm(10.4), etu.filiere)

    c.setFillColor(gris)
    c.setFont("DejaVu", 5.6)
    c.drawString(tx, mm(7), "ANNÉE ACADÉMIQUE")
    c.setFillColor(vert)
    c.setFont("DejaVu-Bold", 8)
    c.drawString(tx, mm(4), etu.annee_academique)


def dessiner_verso(c, etu, jeton: str, edition: int, base: str, cfg: dict) -> None:
    couleurs = cfg["couleurs"]
    vert = HexColor(couleurs["vert"])
    or_couleur = HexColor(couleurs["or"])
    creme = HexColor(couleurs["creme"])
    gris = HexColor(couleurs["gris"])
    blanc = HexColor(couleurs["blanc"])
    w, h = CARD_W, CARD_H

    c.setFillColor(creme)
    c.rect(0, 0, w, h, fill=1, stroke=0)

    qx, qy, qs = mm(4.2), mm(22.6), mm(28)
    c.setFillColor(blanc)
    c.rect(qx, qy, qs, qs, fill=1, stroke=0)
    c.drawImage(ImageReader(io.BytesIO(image_qr(url_qr(base, etu.matricule, jeton)))), qx, qy, qs, qs, mask="auto")
    c.setStrokeColor(or_couleur)
    c.setLineWidth(1.1)
    c.rect(qx - mm(0.7), qy - mm(0.7), qs + mm(1.4), qs + mm(1.4), fill=0, stroke=1)

    tx = mm(35.5)
    c.setFillColor(gris)
    c.setFont("DejaVu", 6.2)
    c.drawString(tx, mm(47.2), "VALABLE JUSQU'AU")
    c.setFillColor(vert)
    c.setFont("DejaVu-Bold", 12)
    c.drawString(tx, mm(41.6), etu.date_validite.strftime("%d/%m/%Y"))
    c.setFillColor(gris)
    c.setFont("DejaVu", 6.4)
    c.drawString(tx, mm(37.2), etu.matricule)
    c.setFont("DejaVu", 6)
    c.drawString(tx, mm(33.2), "VÉRIFICATION")
    _paragraphe(
        c,
        url_affichee(base, etu.matricule),
        tx,
        mm(29.4),
        "DejaVu",
        6.2,
        w - tx - mm(3),
        8,
        vert,
    )

    if cfg.get("code_barres"):
        from reportlab.graphics.barcode import code128

        barre = code128.Code128(etu.matricule, barHeight=mm(7), barWidth=0.35, humanReadable=False)
        barre.drawOn(c, tx, mm(23.2))

    c.setFillColor(HexColor(couleurs["gris_clair"]))
    c.rect(0, mm(12), w, mm(9), fill=1, stroke=0)
    c.setFillColor(gris)
    c.setFont("DejaVu", 5.5)
    c.drawString(mm(4.2), mm(16.4), "SIGNATURE DU TITULAIRE")
    c.setStrokeColor(gris)
    c.setLineWidth(0.6)
    c.line(mm(40), mm(14.6), w - mm(16), mm(14.6))
    c.setFont("DejaVu", 6)
    c.drawRightString(w - mm(3.5), mm(16.2), f"Éd. {edition}")

    c.setFillColor(vert)
    c.rect(0, 0, w, mm(12), fill=1, stroke=0)
    _paragraphe(
        c,
        cfg["mention_perte"],
        w / 2,
        mm(7.4),
        "DejaVu",
        5.7,
        w - mm(8),
        7.2,
        blanc,
        centre=True,
    )
    c.setFillColor(or_couleur)
    c.rect(0, 0, mm(1.7), h, fill=1, stroke=0)


def reperes(c, x: float, y: float) -> None:
    c.saveState()
    c.setStrokeColor(HexColor("#222222"))
    c.setLineWidth(0.35)
    longueur, ecart = mm(3.2), mm(1.15)
    coins = ((x, y, -1, -1), (x + CARD_W, y, 1, -1), (x, y + CARD_H, -1, 1), (x + CARD_W, y + CARD_H, 1, 1))
    for cx, cy, sx, sy in coins:
        c.line(cx + sx * ecart, cy, cx + sx * (ecart + longueur), cy)
        c.line(cx, cy + sy * ecart, cx, cy + sy * (ecart + longueur))
    c.restoreState()


def _nouveau_canvas(taille, recto_verso: bool = True):
    assurer_polices()
    tampon = io.BytesIO()
    c = pdf_canvas.Canvas(tampon, pagesize=taille)
    c.setAuthor("Université AFRICAIIM")
    c.setSubject(
        "Primacy 2. CR80, paysage 85,6 × 54 mm ou portrait 54 × 85,6 mm. "
        "Page 1 = recto avec la photo. Page 2 = verso. "
        "Couleurs de l'atelier. Noir en résine K. 100 %, sans ajuster à la page."
    )
    c.setViewerPreference("PrintScaling", "None")
    c.setViewerPreference("Duplex", "DuplexFlipLongEdge" if recto_verso else "Simplex")
    return c, tampon


_MODELES_VIVANTS = {"modele.json", "modele_personnel.json"}


def _chemins_modele(fichier: str) -> tuple[Path, Path]:
    nom = Path(fichier).name
    if nom not in _MODELES_VIVANTS:
        nom = "modele.json"
    return ROOT / "data" / nom, ROOT / "config" / nom


def assurer_modele_vivant(fichier: str = "modele.json") -> Path:
    """Le modèle enregistré dans l'atelier vit dans data/, hors Git.

    Une mise à jour du serveur ne le remplace jamais. Le fichier d'usine
    ne sert que s'il n'existe encore aucune carte enregistrée.
    """
    vivant, usine = _chemins_modele(fichier)
    vivant.parent.mkdir(parents=True, exist_ok=True)
    if not vivant.is_file() and usine.is_file():
        vivant.write_bytes(usine.read_bytes())
    return vivant if vivant.is_file() else usine


def _assurer_ligne_matricule(data: dict) -> dict:
    """Le matricule répété juste au-dessus de « Carte personnelle »."""
    verso = data.get("verso")
    if not isinstance(verso, list):
        return data
    mention = next(
        (
            obj for obj in verso
            if obj.get("id") == "mention"
            or (obj.get("type") == "texte" and "personnelle" in str(obj.get("texte") or "").lower())
        ),
        None,
    )
    if mention is None:
        return data
    micro = next((obj for obj in verso if obj.get("type") == "micro"), None)
    if micro is None:
        micro = {"id": "sceau", "type": "micro", "champ": "matricule"}
        verso.insert(verso.index(mention), micro)
    micro["x"] = round(float(mention.get("x") or 3.69), 2)
    micro["w"] = round(float(mention.get("w") or 77.59), 2)
    micro["h"] = 1.8
    micro["y"] = round(float(mention.get("y") or 49.1) - 2.05, 2)
    micro["couleur"] = "#000000"
    micro["taille"] = 2.8
    micro["gras"] = False
    micro["align"] = "center"
    micro["champ"] = "matricule"
    return data


def charger_modele(fichier: str = "modele.json") -> dict:
    with open(assurer_modele_vivant(fichier), encoding="utf-8") as flux:
        data = json.load(flux)
    if Path(fichier).name == "modele.json":
        data = _assurer_ligne_matricule(data)
    return data


def ecrire_modele(data: dict, fichier: str = "modele.json") -> None:
    chemin = assurer_modele_vivant(fichier)
    chemin.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def charger_modele_personnel() -> dict:
    """Modèle portrait pour les badges du personnel — jamais lié au modèle étudiants."""
    modele = charger_modele("modele_personnel.json")
    modele["orientation"] = "portrait"
    return modele


def _hex(valeur, defaut="#000000"):
    try:
        return HexColor(str(valeur or defaut))
    except (ValueError, AttributeError):
        return HexColor(defaut)


# PDF 100 % RVB = mêmes teintes que l'atelier. Le noir pur part en résine K (TEXTINBLACK).
NOIR_RESINE = HexColor("#000000")
POINT_IMPRIMANTE = 72 / 300


def _est_noir_neutre(couleur) -> bool:
    """#000 et #1A1A1A : résine K. Vert, or et gris du modèle restent tels quels."""
    try:
        rouge, vert, bleu = float(couleur.red), float(couleur.green), float(couleur.blue)
    except AttributeError:
        return False
    chroma = max(rouge, vert, bleu) - min(rouge, vert, bleu)
    return max(rouge, vert, bleu) <= 0.18 and chroma <= 0.045


def _encre(couleur, taille: float | None = None):
    """Couleur exacte du modèle. Gras / régulier viennent de la police, pas de l'encre."""
    if isinstance(couleur, str):
        couleur = _hex(couleur)
    if _est_noir_neutre(couleur):
        return NOIR_RESINE
    return couleur


def _teinte_sur_blanc(couleur, force: float):
    """Même aspect qu'une encre éclaircie, mais en RVB opaque.

    Une transparence dans le PDF force la Primacy à recomposer toute la page
    et décale le vert et l'or. Le blanc de la carte est déjà le fond.
    """
    if isinstance(couleur, str):
        couleur = _hex(couleur)
    taux = max(0.0, min(1.0, float(force)))
    return Color(
        couleur.red * taux + (1.0 - taux),
        couleur.green * taux + (1.0 - taux),
        couleur.blue * taux + (1.0 - taux),
    )


def _aligne_mm(valeur: float) -> float:
    """Aligne un millimètre sur un point de la tête Primacy (300 ppp).

    Un bord entre deux points est mélangé avec le voisin : le vert devient gris.
    """
    return round(float(valeur) / 25.4 * 300) * POINT_IMPRIMANTE


def _valeur_champ(champ: str, etu, edition: int, base: str, jeton: str) -> str:
    fonction = (getattr(etu, "fonction", None) or getattr(etu, "filiere", None) or "").strip()
    femme = str(getattr(etu, "sexe", "") or "").upper() == "F"
    personnel = type(etu).__name__ == "Personnel" or getattr(etu, "__tablename__", None) == "personnels"
    qualite = (
        ("Collaboratrice" if femme else "Collaborateur") if personnel
        else ("Étudiante" if femme else "Étudiant")
    )
    valeurs = {
        "nom": etu.nom,
        "prenom": etu.prenom,
        "matricule": etu.matricule,
        "filiere": etu.filiere,
        "fonction": fonction,
        "ecole": fonction if personnel else (getattr(etu, "filiere", None) or "").strip(),
        "programme": "" if personnel else (getattr(etu, "programme", None) or "").strip(),
        "niveau": "" if personnel else niveau_sur_carte(etu),
        "email": getattr(etu, "email", None) or "",
        "annee_academique": etu.annee_academique if personnel else (niveau_sur_carte(etu) or etu.annee_academique),
        "date_validite": etu.date_validite.strftime("%d/%m/%Y"),
        "url": url_affichee(base, etu.matricule),
        "edition": f"Éd. {edition}",
        "controle": code_controle(jeton),
        "qualite": qualite,
        "sceau": f"UNIVERSITÉ AFRICAIIM · {etu.matricule} · {code_controle(jeton)}",
    }
    return valeurs.get(champ or "", "")


def _texte_objet(obj: dict, etu, jeton: str, edition: int, base: str) -> str:
    if obj.get("personnalise"):
        texte = str(obj.get("personnalise"))
    elif obj.get("type") == "texte":
        texte = obj.get("texte") or ""
    else:
        texte = _valeur_champ(obj.get("champ") or "", etu, edition, base, jeton)
    if obj.get("majuscules"):
        texte = texte.upper()
    return texte


def _graine_atelier(jeton: str) -> int:
    """Même graine que graineCarte() : le motif doré change avec le code de contrôle."""
    texte = code_controle(jeton) if jeton else "carte"
    somme = 0
    for car in texte:
        somme = (somme * 33 + ord(car)) & 0xFFFFFFFF
    return somme


def _baseline(police: str, taille: float, hauteur: float, interligne: float, en_haut: bool) -> float:
    """Ligne de base depuis le bas de la boîte, comme le centrage flex de l'atelier."""
    assurer_polices()
    face = pdfmetrics.getFont(police).face
    montee = face.ascent / 1000.0 * taille
    descente = abs(face.descent) / 1000.0 * taille
    ligne = taille * interligne
    demi = max(0.0, (ligne - (montee + descente)) / 2)
    if en_haut:
        return hauteur - (demi + montee)
    haut = (hauteur - ligne) / 2
    return hauteur - (haut + demi + montee)


def _png_filigrane(recto: bool) -> bytes:
    """U sauge et gland or, déjà posés sur blanc : la Primacy imprime ces teintes, pas un vert transparent."""
    cle = "recto" if recto else "verso"
    cache = getattr(_png_filigrane, "_cache", {})
    if cle in cache:
        return cache[cle]
    from PIL import Image

    source = Image.open(ROOT / "static" / "marque-u.png").convert("RGBA")
    # Sauge et or assez francs pour que la Primacy les dépose. Le mélange trop pâle sort gris.
    sauge = (46, 122, 74)
    or_fil = (212, 148, 22)
    pixels = []
    for rouge, vert, bleu, alpha in source.get_flattened_data():
        if alpha < 16:
            pixels.append((255, 255, 255))
            continue
        gland = rouge > bleu + 20 and rouge + 15 >= vert and rouge > 70
        cible = or_fil if gland else sauge
        taux = (0.82 if gland else 0.78) * (alpha / 255.0)
        pixels.append(tuple(
            int(round(cible[canal] * taux + 255 * (1.0 - taux)))
            for canal in range(3)
        ))
    image = source.convert("RGB")
    image.putdata(pixels)
    source = image
    tampon = io.BytesIO()
    source.convert("RGB").save(tampon, format="PNG", dpi=(300, 300))
    contenu = tampon.getvalue()
    cache[cle] = contenu
    _png_filigrane._cache = cache
    return cache[cle]


def _boite_filigrane(recto: bool, page_w: float, page_h: float) -> tuple[float, float, float, float]:
    """Grand U du logo, collé à droite, plus discret au verso."""
    portrait = page_h > page_w + 1
    ratio = 740 / 806
    if recto and portrait:
        hauteur, haut = 36, 28
    elif recto:
        hauteur, haut = 36, 17.2
    elif portrait:
        hauteur, haut = 24, 22
    else:
        hauteur, haut = 28, 14
    largeur = hauteur * ratio
    droite = 1.0
    x = page_w - mm(largeur) - mm(droite)
    y = page_h - mm(haut) - mm(hauteur)
    return x, y, mm(largeur), mm(hauteur)


def _filigrane(c, recto: bool, page_w: float, page_h: float) -> None:
    """Grand U du logo en filigrane, derrière la photo et les textes."""
    x, y, largeur, hauteur = _boite_filigrane(recto, page_w, page_h)
    c.drawImage(
        ImageReader(io.BytesIO(_png_filigrane(recto))),
        x,
        y,
        largeur,
        hauteur,
        preserveAspectRatio=True,
        anchor="c",
        mask=None,
    )


def _rosette(c, x, y, largeur, hauteur, couleur, jeton: str = "") -> None:
    """Rosace de billet : le motif change avec le code de contrôle, sans traits horizontaux."""
    graine = _graine_atelier(jeton)
    phase = (graine % 628) / 100
    def tracer(centre_x: float, centre_y: float, rayon: float) -> None:
        for indice, (lobes, echelle) in enumerate(((5, 0.58), (7, 0.76), (11, 0.94))):
            grand = rayon * echelle
            petit = grand / lobes
            ecart = petit * (0.7 + (graine % 5) * 0.04)
            pas = max(petit, 0.4)
            tours = int(lobes * 2)
            points = 90 * tours
            chemin = c.beginPath()
            for i in range(points + 1):
                angle = (i / points) * math.tau * tours + phase * (indice + 1) * 0.2
                rapport = (grand - petit) / pas
                abscisse = (grand - petit) * math.cos(angle) + ecart * math.cos(rapport * angle)
                ordonnee = (grand - petit) * math.sin(angle) - ecart * math.sin(rapport * angle)
                if i == 0:
                    chemin.moveTo(centre_x + abscisse, centre_y + ordonnee)
                else:
                    chemin.lineTo(centre_x + abscisse, centre_y + ordonnee)
            c.drawPath(chemin, stroke=1, fill=0)
        for facteur in (0.18, 0.34, 0.48):
            c.circle(centre_x, centre_y, rayon * facteur, stroke=1, fill=0)

    c.saveState()
    decoupe = c.beginPath()
    decoupe.rect(x, y, largeur, hauteur)
    c.clipPath(decoupe, stroke=0, fill=0)
    c.setLineWidth(max(0.35, mm(0.5 / PX_ATELIER)))
    c.setLineCap(1)
    c.setLineJoin(1)
    centre_x = x + largeur / 2
    centre_y = y + hauteur / 2
    rayon = min(largeur, hauteur) * 0.46
    c.saveState()
    c.translate(mm(0.12), mm(-0.15))
    c.setStrokeColor(_teinte_sur_blanc(_encre(_hex("#004C22")), 0.35))
    tracer(centre_x, centre_y, rayon)
    c.restoreState()
    c.setStrokeColor(_teinte_sur_blanc(couleur, 0.95))
    tracer(centre_x, centre_y, rayon)
    c.restoreState()


def _guilloche(c, x, y, largeur, hauteur, couleur, jeton: str = "") -> None:
    """Même vagues que toileGuilloche : pas, amplitude et graine de l'atelier."""
    graine = _graine_atelier(jeton)
    phase = (graine % 628) / 100
    c.saveState()
    decoupe = c.beginPath()
    decoupe.rect(x, y, largeur, hauteur)
    c.clipPath(decoupe, stroke=0, fill=0)
    c.setStrokeColor(_teinte_sur_blanc(couleur, 0.42))
    c.setLineWidth(max(0.4, mm(0.6 / PX_ATELIER)))
    c.setLineCap(0)
    c.setLineJoin(0)
    pas = mm(6 / PX_ATELIER)
    amplitude = mm(1.2 / PX_ATELIER)
    periode = mm(16 / PX_ATELIER)
    pas_x = mm(2 / PX_ATELIER)
    indice = 0
    dist = 0.0
    while dist < hauteur:
        chemin = c.beginPath()
        abscisse = 0.0
        premier = True
        while abscisse <= largeur + 0.01:
            crete = math.sin(abscisse / periode + phase + indice * 0.45) * amplitude
            ordonnee = y + hauteur - dist - crete
            if premier:
                chemin.moveTo(x + abscisse, ordonnee)
                premier = False
            else:
                chemin.lineTo(x + abscisse, ordonnee)
            abscisse += pas_x
        c.drawPath(chemin, stroke=1, fill=0)
        dist += pas
        indice += 1
    c.restoreState()


PPP_PHOTO = 300


def _fond_sous(objets: list, obj: dict) -> str:
    """Couleur du rectangle déjà posé sous le centre de l'image."""
    centre_x = float(obj.get("x") or 0) + float(obj.get("w") or 0) / 2
    centre_y = float(obj.get("y") or 0) + float(obj.get("h") or 0) / 2
    fond = "#FFFFFF"
    for autre in objets:
        if autre is obj or autre.get("type") not in ("rect", "piste"):
            continue
        if (
            float(autre.get("x") or 0) <= centre_x <= float(autre.get("x") or 0) + float(autre.get("w") or 0)
            and float(autre.get("y") or 0) <= centre_y <= float(autre.get("y") or 0) + float(autre.get("h") or 0)
        ):
            fond = "#000000" if autre.get("type") == "piste" else str(autre.get("couleur") or fond)
    return fond


def _poser_logo(c, source: bytes, x, y, largeur, hauteur, fond: str) -> None:
    """Logo à 300 ppp, aplati sur la couleur derrière lui. Pas de masque : le vert reste #004C22."""
    from PIL import Image

    image = Image.open(io.BytesIO(source))
    image.load()
    if image.mode != "RGBA":
        image = image.convert("RGBA")
    cible = (max(1, round(largeur / 72 * PPP_PHOTO)), max(1, round(hauteur / 72 * PPP_PHOTO)))
    ratio = min(cible[0] / max(image.width, 1), cible[1] / max(image.height, 1))
    neuf = (max(1, round(image.width * ratio)), max(1, round(image.height * ratio)))
    if image.size != neuf:
        image = _reduire_nette(image, neuf)
    toile = Image.new("RGB", cible, _rgb_tuple(_encre(_hex(fond, "#FFFFFF"))))
    gauche = (cible[0] - image.width) // 2
    haut = (cible[1] - image.height) // 2
    toile.paste(image, (gauche, haut), image)
    tampon = io.BytesIO()
    toile.save(tampon, format="PNG", dpi=(PPP_PHOTO, PPP_PHOTO))
    tampon.seek(0)
    c.drawImage(ImageReader(tampon), x, y, largeur, hauteur, preserveAspectRatio=False, mask=None)


def _rgb_tuple(couleur) -> tuple[int, int, int]:
    return (
        int(round(max(0.0, min(1.0, float(couleur.red))) * 255)),
        int(round(max(0.0, min(1.0, float(couleur.green))) * 255)),
        int(round(max(0.0, min(1.0, float(couleur.blue))) * 255)),
    )


def _reduire_nette(image, cible: tuple[int, int]):
    """Réduit par paliers : un seul grand rétrécissement avale les détails du visage."""
    from PIL import Image

    if image.size == cible:
        return image
    largeur, hauteur = image.size
    while largeur > cible[0] * 2 and hauteur > cible[1] * 2:
        largeur = max(cible[0], largeur // 2)
        hauteur = max(cible[1], hauteur // 2)
        image = image.resize((largeur, hauteur), Image.Resampling.BOX)
    if image.size != cible:
        image = image.resize(cible, Image.Resampling.LANCZOS)
    return image


def _poser_couverture(c, photo: bytes, x, y, largeur, hauteur) -> None:
    """Recadre comme object-fit: cover, puis pose la photo à 300 ppp sans retoucher les couleurs.

    Luminosité / LUT décalaient le visage par rapport à l'atelier. Le noir des photos reste
    en couleur (TEXTINBLACK) : on ne l'écarte plus vers le gris.
    """
    from PIL import Image, ImageOps

    image = ImageOps.exif_transpose(Image.open(io.BytesIO(photo)))
    image.load()
    if image.mode != "RGB":
        image = image.convert("RGB", dither=Image.Dither.NONE)
    largeur_px, hauteur_px = image.size
    if largeur_px <= 0 or hauteur_px <= 0 or largeur <= 0 or hauteur <= 0:
        return
    rapport = largeur / hauteur
    if largeur_px / hauteur_px > rapport:
        garde = max(1, round(hauteur_px * rapport))
        gauche = (largeur_px - garde) // 2
        image = image.crop((gauche, 0, gauche + garde, hauteur_px))
    else:
        garde = max(1, round(largeur_px / rapport))
        haut = int(round((hauteur_px - garde) * 0.18))
        haut = max(0, min(hauteur_px - garde, haut))
        image = image.crop((0, haut, largeur_px, haut + garde))
    cible = (max(1, round(largeur / 72 * PPP_PHOTO)), max(1, round(hauteur / 72 * PPP_PHOTO)))
    if image.size != cible:
        image = _reduire_nette(image, cible)
    tampon = io.BytesIO()
    image.save(tampon, format="PNG", dpi=(PPP_PHOTO, PPP_PHOTO))
    tampon.seek(0)
    c.drawImage(ImageReader(tampon), x, y, largeur, hauteur, preserveAspectRatio=False, mask=None)


def _microtexte(c, obj, etu, jeton, edition, base, x, y, largeur, hauteur) -> None:
    texte = _texte_objet(obj, etu, jeton, edition, base).strip()
    if not texte:
        return
    police = _nom_police(obj)
    taille = float(obj.get("taille") or 2.5)
    motif = f"{texte} · "
    ligne = ""
    while c.stringWidth(ligne + motif, police, taille) <= largeur and len(ligne) < 400:
        ligne += motif
    if not ligne:
        return
    interligne = float(obj.get("interligne") or 1.15)
    largeur_texte = c.stringWidth(ligne, police, taille)
    depart = x + max(0.0, (largeur - largeur_texte) / 2)
    _ecrire_ligne(
        c,
        ligne,
        depart,
        y + _baseline(police, taille, hauteur, interligne, False),
        police,
        taille,
        0,
        False,
        _encre(_hex(obj.get("couleur"), "#000000"), taille),
        renforcer=False,
    )


def _trace(c, obj: dict) -> int:
    contour = obj.get("contour")
    if contour:
        c.setStrokeColor(_encre(_hex(contour, "#1A1A1A")))
        c.setLineWidth(max(0.3, mm(float(obj.get("epaisseur") or 0.25))))
    return 1 if contour else 0


def _forme(c, obj: dict, x, y, largeur, hauteur, rayon) -> None:
    teinte = _encre(_hex(obj.get("couleur"), "#004C22"))
    if obj.get("type") == "piste":
        teinte = NOIR_RESINE
    c.setFillColor(teinte)
    trait = _trace(c, obj)
    if rayon > 0.4:
        c.roundRect(x, y, largeur, hauteur, rayon, fill=1, stroke=trait)
    else:
        c.rect(x, y, largeur, hauteur, fill=1, stroke=trait)


def _ecrire_bloc(c, obj, etu, jeton, edition, base, x, y, largeur, hauteur) -> None:
    texte = _texte_objet(obj, etu, jeton, edition, base)
    if not texte:
        return
    c.saveState()
    decoupe = c.beginPath()
    decoupe.rect(x - mm(0.2), y - mm(0.4), largeur + mm(0.4), max(hauteur, 1) + mm(0.8))
    c.clipPath(decoupe, stroke=0, fill=0)
    taille = float(obj.get("taille", 9))
    align = obj.get("align") or "left"
    approche = float(obj.get("approche") or 0)
    police = _nom_police(obj)
    couleur = _encre(_hex(obj.get("couleur"), "#1A1A1A"), taille)
    coef = float(obj.get("interligne") or 1.15)
    interligne = taille * coef
    souligne = bool(obj.get("souligne"))
    if obj.get("retour") or align == "justify":
        plus_long = max(texte.split() or [""], key=len)
        taille = _taille(c, plus_long, police, taille, largeur, approche)
        interligne = taille * coef
        _paragraphe(
            c,
            texte,
            x,
            y + _baseline(police, taille, hauteur, coef, True),
            police,
            taille,
            largeur,
            interligne,
            couleur,
            align=align,
            approche=approche,
            souligne=souligne,
        )
    else:
        taille = _taille(c, texte, police, taille, largeur, approche)
        largeur_texte = _largeur_texte(c, texte, police, taille, approche)
        if align == "center":
            depart = x + (largeur - largeur_texte) / 2
        elif align == "right":
            depart = x + largeur - largeur_texte
        else:
            depart = x
        baseline = y + _baseline(police, taille, hauteur, coef, False)
        _ecrire_ligne(c, texte, depart, baseline, police, taille, approche, souligne, couleur)
    c.restoreState()


def dessiner_face(c, face: str, etu, photo: bytes, jeton: str, edition: int, base: str, modele: dict | None = None) -> None:
    """Dessine une face à partir du modèle. L'origine est le coin bas-gauche de la carte."""
    modele = modele or charger_modele()
    page_w, page_h = taille_carte(modele)
    c.setFillColor(white)
    c.rect(0, 0, page_w, page_h, fill=1, stroke=0)
    c.saveState()
    decoupe = c.beginPath()
    decoupe.roundRect(0, 0, page_w, page_h, mm(2.2))
    c.clipPath(decoupe, stroke=0, fill=0)
    for obj in modele.get(face, []):
        x = _aligne_mm(float(obj["x"]))
        hauteur = max(POINT_IMPRIMANTE, _aligne_mm(float(obj["h"])))
        y = page_h - _aligne_mm(float(obj["y"])) - hauteur
        largeur = max(POINT_IMPRIMANTE, _aligne_mm(float(obj["w"])))
        if largeur <= 0 or hauteur < 0:
            continue
        rayon = mm(float(obj.get("rayon") or 0))
        type_objet = obj.get("type")
        if type_objet in ("rect", "piste"):
            _forme(c, obj, x, y, largeur, hauteur, 0 if type_objet == "piste" else rayon)
            if obj.get("id") == "fond" and face == "verso":
                _filigrane(c, False, page_w, page_h)
            elif obj.get("id") == "fond" and face == "recto":
                _filigrane(c, True, page_w, page_h)
        elif type_objet == "cercle":
            c.setFillColor(_encre(_hex(obj.get("couleur"), "#F0A020")))
            trait = _trace(c, obj)
            c.ellipse(x, y, x + largeur, y + hauteur, fill=1, stroke=trait)
        elif type_objet == "guilloche":
            _guilloche(c, x, y, largeur, hauteur, _encre(_hex(obj.get("couleur"), "#FEAB00")), jeton)
        elif type_objet == "rosette":
            _rosette(c, x, y, largeur, hauteur, _encre(_hex(obj.get("couleur"), "#FFFFFF")), jeton)
        elif type_objet == "micro":
            _microtexte(c, obj, etu, jeton, edition, base, x, y, largeur, hauteur)
        elif type_objet == "ligne":
            c.setStrokeColor(_encre(_hex(obj.get("couleur"), "#1A1A1A")))
            c.setLineWidth(max(0.4, mm(float(obj.get("epaisseur") or 0.3))))
            c.line(x, y + hauteur / 2, x + largeur, y + hauteur / 2)
        elif type_objet == "image":
            from app.services.designs import chemin_asset_image

            source = chemin_asset_image(obj)
            if source is not None and source.is_file():
                couvrir = str(obj.get("ajustement") or "contain") == "cover"
                if couvrir:
                    _poser_couverture(c, source.read_bytes(), x, y, largeur, hauteur)
                else:
                    _poser_logo(c, source.read_bytes(), x, y, largeur, hauteur, _fond_sous(modele.get(face, []), obj))
        elif type_objet == "photo":
            c.saveState()
            if rayon > 0.4:
                chemin = c.beginPath()
                chemin.roundRect(x, y, largeur, hauteur, rayon)
                c.clipPath(chemin, stroke=0, fill=0)
            c.setFillColor(_encre(_hex(obj.get("couleur"), "#C5F0DC")))
            c.rect(x, y, largeur, hauteur, fill=1, stroke=0)
            if photo:
                _poser_couverture(c, photo, x, y, largeur, hauteur)
            elif obj.get("initiales", True):
                initiales = f"{(etu.prenom or ' ')[:1]}{(etu.nom or ' ')[:1]}".upper()
                taille_ini = min(hauteur * 0.38, 32)
                c.setFillColor(_encre(_hex(obj.get("couleur_texte"), "#0C4630")))
                c.setFont("DejaVu-Bold", taille_ini)
                c.drawCentredString(
                    x + largeur / 2,
                    y + _baseline("DejaVu-Bold", taille_ini, hauteur, 1.15, False),
                    initiales,
                )
            c.restoreState()
        elif type_objet == "qr":
            c.setFillColor(_hex(obj.get("fond"), "#FFFFFF"))
            c.rect(x, y, largeur, hauteur, fill=1, stroke=0)
            _dessiner_qr(
                c,
                _charge_qr(obj, etu, jeton, edition, base),
                x,
                y,
                largeur,
                hauteur,
                obj.get("couleur") or "#111111",
            )
            if obj.get("cadre", True):
                c.setStrokeColor(_encre(_hex("#FEAB00")))
                c.setLineWidth(1.15)
                c.roundRect(x - mm(0.55), y - mm(0.55), largeur + mm(1.1), hauteur + mm(1.1), mm(0.7), fill=0, stroke=1)
        elif type_objet == "codebarres":
            from reportlab.graphics.barcode.code128 import Code128

            brut = _valeur_champ(obj.get("champ") or "matricule", etu, edition, base, jeton)
            propre = "".join(car if 32 <= ord(car) <= 126 else "-" for car in brut) or "0"
            lisible = bool(obj.get("lisible"))
            vertical = obj.get("sens") == "vertical"
            zone_w = hauteur if vertical else largeur
            zone_h = largeur if vertical else hauteur
            reserve = mm(2.6) if lisible else 0
            sonde = Code128(propre, barWidth=1, barHeight=10, quiet=0, humanReadable=0)
            facteur = zone_w / sonde.width if sonde.width else 1
            # Chaque barre fait un nombre entier de points de tête (300 ppp), au moins deux :
            # sinon les barres fines s'élargissent au hasard et le lecteur hésite.
            points = max(2, math.floor(facteur / POINT_IMPRIMANTE + 0.05))
            module = points * POINT_IMPRIMANTE
            encre = _encre(_hex(obj.get("couleur"), "#111111"), 0)
            barre = Code128(
                propre,
                barWidth=module,
                barHeight=max(mm(2), zone_h - reserve),
                quiet=0,
                humanReadable=1 if lisible else 0,
                fontName="DejaVu-Bold",
                fontSize=6,
                barFillColor=encre,
                textColor=encre,
            )
            decalage = (zone_w - barre.width) / 2
            c.setFillColor(_hex(obj.get("fond"), "#FFFFFF"))
            c.rect(x, y, largeur, hauteur, fill=1, stroke=0)
            c.setFillColor(encre)
            if vertical:
                c.saveState()
                c.translate(x + largeur / 2, y + hauteur / 2)
                c.rotate(90)
                barre.drawOn(c, -zone_w / 2 + decalage, -zone_h / 2 + reserve)
                c.restoreState()
            else:
                depart = round((x + decalage) / POINT_IMPRIMANTE) * POINT_IMPRIMANTE
                barre.drawOn(c, depart, y + reserve)
        elif type_objet in ("champ", "texte"):
            _ecrire_bloc(c, obj, etu, jeton, edition, base, x, y, largeur, hauteur)
    c.restoreState()


def _dessiner_verso(c, etu, photo, jeton: str, edition: int, base: str, retourner: bool, modele: dict | None = None) -> None:
    """Tourne le verso de 180° : après le retournement bord long de la Primacy, il est à l'endroit."""
    modele = modele or charger_modele()
    if retourner:
        page_w, page_h = taille_carte(modele)
        c.saveState()
        c.translate(page_w, page_h)
        c.rotate(180)
    dessiner_face(c, "verso", etu, photo, jeton, edition, base, modele=modele)
    if retourner:
        c.restoreState()


def pdf_individuel(
    etu, photo: bytes, jeton: str, edition: int, base: str,
    recto_verso: bool = True, retourner_verso: bool = False, modele: dict | None = None,
) -> bytes:
    modele = modele or charger_modele()
    c, tampon = _nouveau_canvas(taille_carte(modele), recto_verso)
    c.setTitle(f"Carte {etu.matricule}")
    dessiner_face(c, "recto", etu, photo, jeton, edition, base, modele=modele)
    c.showPage()
    _dessiner_verso(c, etu, photo, jeton, edition, base, retourner_verso and recto_verso, modele=modele)
    c.save()
    return tampon.getvalue()


def pdf_badge_personnel(
    personne, photo: bytes, jeton: str, edition: int, base: str,
    recto_verso: bool = True, retourner_verso: bool | None = None,
) -> bytes:
    """Badge personnel en portrait. Verso tourné pour la Primacy (bord long)."""
    if retourner_verso is None:
        retourner_verso = bool(recto_verso)
    return pdf_individuel(
        personne, photo, jeton, edition, base,
        recto_verso=recto_verso, retourner_verso=retourner_verso, modele=charger_modele_personnel(),
    )


def fiche_design_personnel():
    """Fiche neutre : un design importé n'a pas besoin d'une personne en base."""
    from datetime import date
    from types import SimpleNamespace

    return SimpleNamespace(
        nom="",
        prenom="",
        matricule="DESIGN",
        numero="DESIGN",
        fonction="",
        filiere="",
        email="",
        sexe="M",
        annee_academique="",
        date_validite=date(2099, 12, 31),
        photo_chemin=None,
    )


def element_design_personnel(base: str | None = None) -> tuple:
    """(fiche, photo, jeton, édition) pour imprimer uniquement le modèle atelier personnel."""
    from app.services.photos import portrait_initiales

    fiche = fiche_design_personnel()
    photo = portrait_initiales("D", "G")
    return fiche, photo, "design-atelier", 1


def pdf_design_personnel(
    recto_verso: bool = True, retourner_verso: bool | None = None, base: str | None = None,
) -> bytes:
    """PDF du modèle personnel (design importé). Verso tourné pour la Primacy (bord long)."""
    from app.config import base_url as _base

    if retourner_verso is None:
        retourner_verso = bool(recto_verso)
    adresse = base or _base()
    fiche, photo, jeton, edition = element_design_personnel(adresse)
    return pdf_individuel(
        fiche, photo, jeton, edition, adresse,
        recto_verso=recto_verso, retourner_verso=retourner_verso, modele=charger_modele_personnel(),
    )


def pdf_primacy(elements: list[tuple], base: str, titre: str) -> bytes:
    """Un PDF CR80 : pour chaque carte, le recto puis le verso déjà tourné pour la Primacy 2."""
    if not elements:
        raise ValueError("Aucune carte à imprimer dans ce lot.")
    c, tampon = _nouveau_canvas(taille_carte())
    c.setTitle(f"Université AFRICAIIM — {titre}")
    for etu, photo, jeton, edition in elements:
        dessiner_face(c, "recto", etu, photo, jeton, edition, base)
        c.showPage()
        _dessiner_verso(c, etu, photo, jeton, edition, base, False)
        c.showPage()
    c.save()
    return tampon.getvalue()


def positions_paires(largeur: float, hauteur: float) -> list[tuple[float, float]]:
    """Coin bas gauche de chaque paire recto | verso sur une feuille A4, du haut vers le bas."""
    marge, ecart, reserve_bas = mm(12), mm(9), mm(16)
    lignes = max(1, int((A4_H - 2 * marge - reserve_bas + ecart) // (hauteur + ecart)))
    x = (A4_W - 2 * largeur) / 2
    return [(x, A4_H - marge - hauteur - ligne * (hauteur + ecart)) for ligne in range(lignes)]


def _reperes_paire(c, x: float, y: float, largeur: float, hauteur: float) -> None:
    c.saveState()
    c.setStrokeColor(HexColor("#C8C8C8"))
    c.setLineWidth(0.25)
    c.rect(x, y, 2 * largeur, hauteur, fill=0, stroke=1)
    c.setStrokeColor(HexColor("#222222"))
    c.setLineWidth(0.35)
    longueur, ecart = mm(3.2), mm(1.15)
    droite = x + 2 * largeur
    for cx, cy, sx, sy in ((x, y, -1, -1), (droite, y, 1, -1), (x, y + hauteur, -1, 1), (droite, y + hauteur, 1, 1)):
        c.line(cx + sx * ecart, cy, cx + sx * (ecart + longueur), cy)
        c.line(cx, cy + sy * ecart, cx, cy + sy * (ecart + longueur))
    pli = x + largeur
    c.setDash(1.5, 1.5)
    c.line(pli, y - ecart, pli, y - ecart - longueur)
    c.line(pli, y + hauteur + ecart, pli, y + hauteur + ecart + longueur)
    c.restoreState()


def _face_decoupee(c, face: str, x: float, y: float, largeur: float, hauteur: float, element: tuple, base: str, modele: dict | None = None) -> None:
    etu, photo, jeton, edition = element
    c.saveState()
    c.translate(x, y)
    cadre = c.beginPath()
    cadre.rect(0, 0, largeur, hauteur)
    c.clipPath(cadre, stroke=0, fill=0)
    dessiner_face(c, face, etu, photo, jeton, edition, base, modele=modele)
    c.restoreState()


def pdf_feuille_a4(elements: list[tuple], base: str, titre: str, modele: dict | None = None) -> bytes:
    """Pour toute imprimante : chaque carte en recto | verso côte à côte, taille réelle, à découper et plier.

    Pas de recto-verso ni de format spécial : une feuille A4 ordinaire suffit.
    """
    if not elements:
        raise ValueError("Aucune carte à imprimer.")
    modele = modele or charger_modele()
    largeur, hauteur = taille_carte(modele)
    places = positions_paires(largeur, hauteur)
    c, tampon = _nouveau_canvas((A4_W, A4_H), recto_verso=False)
    c.setTitle(f"Université AFRICAIIM — {titre}")
    c.setSubject("Feuille A4, toute imprimante. Imprimer à 100 % (taille réelle), recto seul.")
    pages = [elements[i : i + len(places)] for i in range(0, len(elements), len(places))]
    for index, page in enumerate(pages, start=1):
        for element, (x, y) in zip(page, places):
            _face_decoupee(c, "recto", x, y, largeur, hauteur, element, base, modele=modele)
            _face_decoupee(c, "verso", x + largeur, y, largeur, hauteur, element, base, modele=modele)
            _reperes_paire(c, x, y, largeur, hauteur)
        c.setFillColor(HexColor("#222222"))
        c.setFont("DejaVu", 7.5)
        c.drawString(
            mm(12), mm(9),
            "Imprimez à 100 % (taille réelle). Découpez sur les repères, pliez sur le pointillé : "
            "recto devant, verso derrière.",
        )
        suite = f" · feuille {index}/{len(pages)}" if len(pages) > 1 else ""
        c.drawString(mm(12), mm(5.5), f"AFRICAIIM · {titre}{suite}")
        c.showPage()
    c.save()
    return tampon.getvalue()


def pdf_lot(elements: list[tuple], base: str, titre: str) -> bytes:
    """elements : (etudiant, photo, jeton, edition)."""
    if not elements:
        raise ValueError("Aucune carte à imprimer dans ce lot.")
    slots = positions_lot()
    c, tampon = _nouveau_canvas((A4_W, A4_H))
    c.setTitle(f"Lot {titre}")
    pages = [elements[i : i + len(slots)] for i in range(0, len(elements), len(slots))]
    for index, page in enumerate(pages, start=1):
        for face in ("RECTO", "VERSO"):
            c.setFillColor(white)
            c.rect(0, 0, A4_W, A4_H, fill=1, stroke=0)
            for element, (x, y) in zip(page, slots):
                etu, photo, jeton, edition = element
                reperes(c, x, y)
                c.saveState()
                c.translate(x, y)
                if face == "RECTO":
                    dessiner_face(c, "recto", etu, photo, jeton, edition, base)
                else:
                    dessiner_face(c, "verso", etu, photo, jeton, edition, base)
                c.restoreState()
            c.setFillColor(HexColor("#222222"))
            c.setFont("DejaVu", 8)
            consigne = (
                "RECTO — puis retournez la feuille sur le grand côté"
                if face == "RECTO"
                else "VERSO — même emplacement que le recto"
            )
            c.drawString(mm(10), mm(5.5), f"AFRICAIIM · {titre} · {consigne} · feuille {index}/{len(pages)}")
            c.showPage()
    c.save()
    return tampon.getvalue()


PPP_PVC = 300
_POLICES_FICHIER = {
    "DejaVu": "DejaVuSans.ttf",
    "DejaVu-Bold": "DejaVuSans-Bold.ttf",
    "DejaVu-Oblique": "DejaVuSans-Oblique.ttf",
    "DejaVu-BoldOblique": "DejaVuSans-BoldOblique.ttf",
    "DejaVuSerif": "DejaVuSerif.ttf",
    "DejaVuSerif-Bold": "DejaVuSerif-Bold.ttf",
    "DejaVuSerif-Italic": "DejaVuSerif-Italic.ttf",
    "DejaVuSerif-BoldItalic": "DejaVuSerif-BoldItalic.ttf",
}


def _px_pvc(mm_val: float) -> int:
    return max(1, int(round(float(mm_val) * PPP_PVC / 25.4)))


def _rgb_encre(valeur, defaut="#000000") -> tuple[int, int, int]:
    couleur = _encre(_hex(valeur, defaut))
    return (
        int(round(_borne_canal(couleur.red) * 255)),
        int(round(_borne_canal(couleur.green) * 255)),
        int(round(_borne_canal(couleur.blue) * 255)),
    )


def _borne_canal(valeur: float) -> float:
    return max(0.0, min(1.0, float(valeur)))


def _police_pvc(obj: dict, taille_pt: float):
    from PIL import ImageFont

    pixels = max(9, int(round(float(taille_pt) * PPP_PVC / 72)))
    nom = _nom_police(obj)
    fichier = ROOT / "fonts" / _POLICES_FICHIER.get(nom, "DejaVuSans.ttf")
    if not fichier.is_file():
        regulier, gras = polices()
        fichier = gras if obj.get("gras") else regulier
    return ImageFont.truetype(str(fichier), pixels)


def _coller(fond, piece, x: int, y: int) -> None:
    if piece.mode == "RGBA":
        fond.paste(piece, (x, y), piece)
    else:
        fond.paste(piece.convert("RGB"), (x, y))


def _texte_pvc(dessin, image, obj, etu, jeton, edition, base, boite) -> None:
    from PIL import ImageDraw

    x, y, largeur, hauteur = boite
    texte = _texte_objet(obj, etu, jeton, edition, base)
    if not texte:
        return
    taille = float(obj.get("taille") or 9)
    police = _police_pvc(obj, taille)
    couleur = _rgb_encre(obj.get("couleur"), "#1A1A1A")
    retour = bool(obj.get("retour") or obj.get("align") == "justify")
    align = obj.get("align") or "left"
    if not retour:
        bbox = dessin.textbbox((0, 0), texte, font=police)
        tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
        while tw > largeur - 2 and taille > 5.4:
            taille -= 0.15
            police = _police_pvc(obj, taille)
            bbox = dessin.textbbox((0, 0), texte, font=police)
            tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
        if align == "center":
            tx = x + max(0, (largeur - tw) // 2)
        elif align == "right":
            tx = x + max(0, largeur - tw)
        else:
            tx = x
        ty = y + max(0, (hauteur - th) // 2) - bbox[1]
        dessin.text((tx, ty), texte, font=police, fill=couleur)
        return
    mots = texte.split()
    lignes: list[str] = []
    courante = ""
    for mot in mots:
        essai = mot if not courante else f"{courante} {mot}"
        if dessin.textlength(essai, font=police) <= max(largeur - 2, 8):
            courante = essai
        else:
            if courante:
                lignes.append(courante)
            courante = mot
    if courante:
        lignes.append(courante)
    inter = int(round(taille * PPP_PVC / 72 * float(obj.get("interligne") or 1.15)))
    curseur = y
    for ligne in lignes:
        bbox = dessin.textbbox((0, 0), ligne, font=police)
        tw = bbox[2] - bbox[0]
        if align == "center":
            tx = x + max(0, (largeur - tw) // 2)
        elif align == "right":
            tx = x + max(0, largeur - tw)
        else:
            tx = x
        dessin.text((tx, curseur - bbox[1]), ligne, font=police, fill=couleur)
        curseur += inter
        if curseur > y + hauteur:
            break
    _ = image


def _qr_pvc(largeur: int, hauteur: int, url: str, encre="#000000", fond="#FFFFFF"):
    from PIL import Image, ImageDraw

    code = qrcode.QRCode(error_correction=qrcode.constants.ERROR_CORRECT_H, border=2)
    code.add_data(url)
    code.make(fit=True)
    matrice = code.get_matrix()
    n = len(matrice)
    img = Image.new("RGB", (largeur, hauteur), _rgb_encre(fond, "#FFFFFF"))
    if n <= 0:
        return img
    cote = min(largeur, hauteur)
    ox = (largeur - cote) // 2
    oy = (hauteur - cote) // 2
    pas = cote / n
    dessin = ImageDraw.Draw(img)
    noir = _rgb_encre(encre, "#000000")
    for ligne, rangee in enumerate(matrice):
        col = 0
        while col < n:
            if not rangee[col]:
                col += 1
                continue
            debut = col
            while col < n and rangee[col]:
                col += 1
            dessin.rectangle(
                [
                    ox + debut * pas,
                    oy + ligne * pas,
                    ox + col * pas + 0.4,
                    oy + (ligne + 1) * pas + 0.4,
                ],
                fill=noir,
            )
    return img


def rendre_face_pvc(face: str, etu, photo: bytes, jeton: str, edition: int, base: str, modele: dict):
    """Bitmap 300 ppp identique à l'atelier, pour que la Primacy sorte la même carte."""
    from PIL import Image, ImageDraw

    from app.services.designs import chemin_asset_image

    page_w, page_h = taille_carte(modele)
    largeur_mm = page_w / MM
    hauteur_mm = page_h / MM
    W, H = _px_pvc(largeur_mm), _px_pvc(hauteur_mm)
    image = Image.new("RGB", (W, H), (255, 255, 255))
    dessin = ImageDraw.Draw(image)
    portrait = hauteur_mm > largeur_mm + 1
    for obj in modele.get(face, []):
        x = _px_pvc(float(obj["x"]))
        y = _px_pvc(float(obj["y"]))
        largeur = _px_pvc(float(obj["w"]))
        hauteur = _px_pvc(float(obj["h"]))
        kind = obj.get("type")
        if kind in ("rect", "piste"):
            teinte = (0, 0, 0) if kind == "piste" else _rgb_encre(obj.get("couleur"), "#004C22")
            rayon = _px_pvc(float(obj.get("rayon") or 0))
            if rayon > 2:
                dessin.rounded_rectangle([x, y, x + largeur, y + hauteur], radius=rayon, fill=teinte)
            else:
                dessin.rectangle([x, y, x + largeur, y + hauteur], fill=teinte)
        elif kind == "image":
            source = chemin_asset_image(obj)
            if obj.get("id") == "logo" and (source is None or not source.is_file()):
                source = ROOT / "static" / "marque-blanc.png"
            if source is not None and Path(source).is_file():
                logo = Image.open(source).convert("RGBA")
                logo.thumbnail((largeur, hauteur), Image.Resampling.LANCZOS)
                px = x + (largeur - logo.width) // 2
                py = y + (hauteur - logo.height) // 2
                _coller(image, logo, px, py)
        elif kind == "photo":
            fond = Image.new("RGB", (largeur, hauteur), _rgb_encre(obj.get("couleur"), "#E8F3EC"))
            if photo:
                from PIL import ImageOps

                portrait_img = ImageOps.exif_transpose(Image.open(io.BytesIO(photo))).convert("RGB")
                rapport = largeur / hauteur
                pw, ph = portrait_img.size
                if pw / ph > rapport:
                    garde = max(1, round(ph * rapport))
                    gauche = (pw - garde) // 2
                    portrait_img = portrait_img.crop((gauche, 0, gauche + garde, ph))
                else:
                    garde = max(1, round(pw / rapport))
                    haut = int(round((ph - garde) * 0.18))
                    haut = max(0, min(ph - garde, haut))
                    portrait_img = portrait_img.crop((0, haut, pw, haut + garde))
                portrait_img = portrait_img.resize((largeur, hauteur), Image.Resampling.LANCZOS)
                fond.paste(portrait_img, (0, 0))
            rayon = _px_pvc(float(obj.get("rayon") or 0))
            if rayon > 1:
                masque = Image.new("L", (largeur, hauteur), 0)
                ImageDraw.Draw(masque).rounded_rectangle([0, 0, largeur, hauteur], radius=rayon, fill=255)
                coin = Image.new("RGB", (largeur, hauteur), (255, 255, 255))
                coin.paste(fond, (0, 0), masque)
                fond = coin
            image.paste(fond, (x, y))
        elif kind == "qr":
            qr = _qr_pvc(
                largeur,
                hauteur,
                _charge_qr(obj, etu, jeton, edition, base),
                obj.get("couleur") or "#000000",
                obj.get("fond") or "#FFFFFF",
            )
            image.paste(qr, (x, y))
        elif kind in ("champ", "texte"):
            _texte_pvc(dessin, image, obj, etu, jeton, edition, base, (x, y, largeur, hauteur))
    filigrane = ROOT / "static" / ("filigrane.png" if face == "recto" else "filigrane-verso.png")
    if filigrane.is_file():
        ratio = 740 / 806
        if face == "recto" and portrait:
            haut_mm, h_mm = 28, 36
        elif face == "recto":
            haut_mm, h_mm = 17.2, 36
        elif portrait:
            haut_mm, h_mm = 22, 24
        else:
            haut_mm, h_mm = 14, 28
        fw, fh = _px_pvc(h_mm * ratio), _px_pvc(h_mm)
        motif = Image.open(filigrane).convert("RGBA").resize((fw, fh), Image.Resampling.LANCZOS)
        gx = W - fw - _px_pvc(1)
        gy = _px_pvc(haut_mm)
        _coller(image, motif, gx, gy)
    rayon_carte = _px_pvc(2.2)
    masque = Image.new("L", (W, H), 0)
    ImageDraw.Draw(masque).rounded_rectangle([0, 0, W - 1, H - 1], radius=rayon_carte, fill=255)
    fond_blanc = Image.new("RGB", (W, H), (255, 255, 255))
    fond_blanc.paste(image, (0, 0), masque)
    return fond_blanc


def pdf_pvc(
    etu, photo: bytes, jeton: str, edition: int, base: str,
    recto_verso: bool = True, retourner_verso: bool = False, modele: dict | None = None,
) -> bytes:
    """PDF CR80 dont chaque page est l'image 300 ppp de l'atelier — même qualité que l'écran."""
    modele = modele or charger_modele()
    page_w, page_h = taille_carte(modele)
    recto = rendre_face_pvc("recto", etu, photo, jeton, edition, base, modele)
    verso = rendre_face_pvc("verso", etu, photo, jeton, edition, base, modele)
    if retourner_verso and recto_verso:
        verso = verso.rotate(180)
    c, tampon = _nouveau_canvas((page_w, page_h), recto_verso)
    c.setTitle(f"Carte {etu.matricule}")
    faces = [recto, verso] if recto_verso else [recto]
    for face_img in faces:
        tampon_img = io.BytesIO()
        face_img.save(tampon_img, format="PNG", dpi=(PPP_PVC, PPP_PVC))
        tampon_img.seek(0)
        c.drawImage(ImageReader(tampon_img), 0, 0, page_w, page_h, preserveAspectRatio=False, mask=None)
        c.showPage()
    c.save()
    return tampon.getvalue()
