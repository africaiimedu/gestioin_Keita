"""PDF CR80 (85,6 × 54 mm) pour l'Evolis Primacy 2 : recto, puis verso."""

from __future__ import annotations

import hashlib
import io
import json
import math
from urllib.parse import quote

import qrcode
from reportlab.lib.colors import Color, HexColor, white
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas as pdf_canvas

from app.config import ROOT, charger_config, chemin_logo, polices

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
    return f"{base.rstrip('/')}/verif/{quote(matricule)}?t={jeton}"


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
    cote = min(largeur, hauteur)
    origine_x = x + (largeur - cote) / 2
    origine_y = y + (hauteur - cote) / 2
    pas = cote / nombre
    c.setFillColor(_hex(encre, "#111111"))
    for ligne, rangee in enumerate(matrice):
        for colonne, noir in enumerate(rangee):
            if noir:
                c.rect(
                    origine_x + colonne * pas,
                    origine_y + (nombre - 1 - ligne) * pas,
                    pas,
                    pas,
                    stroke=0,
                    fill=1,
                )


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
    while taille > 3.3 and _largeur_texte(c, texte, police, taille, approche) > largeur:
        taille -= 0.15
    return taille


def _largeur_texte(c, texte: str, police: str, taille: float, approche: float) -> float:
    if not texte:
        return 0
    return c.stringWidth(texte, police, taille) + approche * max(0, len(texte) - 1)


def _ecrire_ligne(c, texte, x, baseline, police, taille, approche, souligne, couleur) -> float:
    c.setFillColor(couleur)
    c.setFont(police, taille)
    if approche:
        curseur = x
        for car in texte:
            c.drawString(curseur, baseline, car)
            curseur += c.stringWidth(car, police, taille) + approche
        fin = curseur - approche
    else:
        c.drawString(x, baseline, texte)
        fin = x + c.stringWidth(texte, police, taille)
    if souligne and texte:
        c.setStrokeColor(couleur)
        c.setLineWidth(max(0.35, taille * 0.06))
        c.line(x, baseline - taille * 0.15, fin, baseline - taille * 0.15)
    return fin - x


def _paragraphe(c, texte, x, y, police, taille, largeur, interligne, couleur, centre=False, align="left", approche=0, souligne=False):
    mots = texte.split()
    lignes: list[str] = []
    courante = ""
    limite = max(largeur, 4)
    for mot in mots:
        essai = mot if not courante else f"{courante} {mot}"
        if _largeur_texte(c, essai, police, taille, approche) <= limite:
            courante = essai
        else:
            if courante:
                lignes.append(courante)
            courante = mot
    if courante:
        lignes.append(courante)
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
        "Couleurs RVB de la carte, 100 %, sans ajuster à la page."
    )
    c.setViewerPreference("PrintScaling", "None")
    c.setViewerPreference("Duplex", "DuplexFlipLongEdge" if recto_verso else "Simplex")
    return c, tampon


def charger_modele() -> dict:
    with open(ROOT / "config" / "modele.json", encoding="utf-8") as fichier:
        return json.load(fichier)


def _hex(valeur, defaut="#000000"):
    try:
        return HexColor(str(valeur or defaut))
    except (ValueError, AttributeError):
        return HexColor(defaut)


def _valeur_champ(champ: str, etu, edition: int, base: str, jeton: str) -> str:
    valeurs = {
        "nom": etu.nom,
        "prenom": etu.prenom,
        "matricule": etu.matricule,
        "filiere": etu.filiere,
        "ecole": (getattr(etu, "filiere", None) or "").strip(),
        "email": getattr(etu, "email", None) or "",
        "annee_academique": etu.annee_academique,
        "date_validite": etu.date_validite.strftime("%d/%m/%Y"),
        "url": url_affichee(base, etu.matricule),
        "edition": f"Éd. {edition}",
        "controle": code_controle(jeton),
        "qualite": "Étudiante" if str(getattr(etu, "sexe", "") or "").upper() == "F" else "Étudiant",
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
    """Le grand U coiffé du logo, pâle, sans fond. Plus lisible au recto."""
    cle = "recto" if recto else "verso"
    cache = getattr(_png_filigrane, "_cache", {})
    if cle in cache:
        return cache[cle]
    from PIL import Image

    source = Image.open(ROOT / "static" / "marque-u.png").convert("RGBA")
    pixels = []
    for rouge, vert, bleu, alpha in source.get_flattened_data():
        if alpha < 16:
            pixels.append((0, 0, 0, 0))
            continue
        gland = rouge > 170 and vert > 120 and bleu < 120
        force = (130 if gland else 90) if recto else (78 if gland else 48)
        pixels.append((rouge, vert, bleu, min(alpha, force)))
    source.putdata(pixels)
    tampon = io.BytesIO()
    source.save(tampon, format="PNG")
    contenu = tampon.getvalue()
    nom = "filigrane.png" if recto else "filigrane-verso.png"
    (ROOT / "static" / nom).write_bytes(contenu)
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
        mask="auto",
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
    c.setStrokeColor(HexColor("#004C22"))
    c._setStrokeAlpha(0.35)
    tracer(centre_x, centre_y, rayon)
    c.restoreState()
    c.setStrokeColor(couleur)
    c._setStrokeAlpha(0.95)
    tracer(centre_x, centre_y, rayon)
    c.restoreState()
    c._setStrokeAlpha(1)


def _guilloche(c, x, y, largeur, hauteur, couleur, jeton: str = "") -> None:
    """Même vagues que toileGuilloche : pas, amplitude et graine de l'atelier."""
    graine = _graine_atelier(jeton)
    phase = (graine % 628) / 100
    c.saveState()
    decoupe = c.beginPath()
    decoupe.rect(x, y, largeur, hauteur)
    c.clipPath(decoupe, stroke=0, fill=0)
    c.setStrokeColor(couleur)
    c.setLineWidth(max(0.4, mm(0.6 / PX_ATELIER)))
    c.setLineCap(0)
    c.setLineJoin(0)
    c._setStrokeAlpha(0.42)
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
    c._setStrokeAlpha(1)
    c._setFillAlpha(1)


def _poser_couverture(c, photo: bytes, x, y, largeur, hauteur) -> None:
    """Recadre la photo comme object-fit: cover. JPEG 95, sans sous-échantillonnage des couleurs."""
    from PIL import Image, ImageOps

    image = ImageOps.exif_transpose(Image.open(io.BytesIO(photo)))
    image.load()
    if image.mode != "RGB":
        image = image.convert("RGB")
    largeur_px, hauteur_px = image.size
    if largeur_px <= 0 or hauteur_px <= 0:
        return
    echelle = max(largeur / largeur_px, hauteur / hauteur_px)
    dest_w = largeur_px * echelle
    dest_h = hauteur_px * echelle
    tampon = io.BytesIO()
    image.save(tampon, format="JPEG", quality=95, subsampling=0, optimize=True)
    tampon.seek(0)
    c.drawImage(
        ImageReader(tampon),
        x + (largeur - dest_w) / 2,
        y + (hauteur - dest_h) / 2,
        dest_w,
        dest_h,
        preserveAspectRatio=False,
        mask=None,
    )


def _microtexte(c, obj, etu, jeton, edition, base, x, y, largeur, hauteur) -> None:
    texte = _texte_objet(obj, etu, jeton, edition, base).strip()
    if not texte:
        return
    police = _nom_police(obj)
    taille = float(obj.get("taille") or 2.5)
    c.setFillColor(_hex(obj.get("couleur"), "#FEAB00"))
    c.setFont(police, taille)
    motif = f"{texte} · "
    ligne = ""
    while c.stringWidth(ligne + motif, police, taille) <= largeur and len(ligne) < 400:
        ligne += motif
    if ligne:
        interligne = float(obj.get("interligne") or 1.15)
        c._setFillAlpha(1)
        c.drawString(x, y + _baseline(police, taille, hauteur, interligne, False), ligne)


def _trace(c, obj: dict) -> int:
    contour = obj.get("contour")
    if contour:
        c.setStrokeColor(_hex(contour, "#1A1A1A"))
        c.setLineWidth(max(0.3, mm(float(obj.get("epaisseur") or 0.25))))
    return 1 if contour else 0


def _forme(c, obj: dict, x, y, largeur, hauteur, rayon) -> None:
    c.setFillColor(_hex(obj.get("couleur"), "#004C22"))
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
    decoupe.rect(x, y, largeur, max(hauteur, 1))
    c.clipPath(decoupe, stroke=0, fill=0)
    police = _nom_police(obj)
    couleur = _hex(obj.get("couleur"), "#1A1A1A")
    taille = float(obj.get("taille", 9))
    align = obj.get("align") or "left"
    approche = float(obj.get("approche") or 0)
    coef = float(obj.get("interligne") or 1.15)
    interligne = taille * coef
    souligne = bool(obj.get("souligne"))
    c._setFillAlpha(1)
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


def dessiner_face(c, face: str, etu, photo: bytes, jeton: str, edition: int, base: str) -> None:
    """Dessine une face à partir du modèle. L'origine est le coin bas-gauche de la carte."""
    modele = charger_modele()
    page_w, page_h = taille_carte(modele)
    c.setFillColor(white)
    c.rect(0, 0, page_w, page_h, fill=1, stroke=0)
    c.saveState()
    decoupe = c.beginPath()
    decoupe.roundRect(0, 0, page_w, page_h, mm(2.2))
    c.clipPath(decoupe, stroke=0, fill=0)
    for obj in modele.get(face, []):
        x = mm(float(obj["x"]))
        hauteur = mm(float(obj["h"]))
        y = page_h - mm(float(obj["y"])) - hauteur
        largeur = mm(float(obj["w"]))
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
            c.setFillColor(_hex(obj.get("couleur"), "#F0A020"))
            trait = _trace(c, obj)
            c.ellipse(x, y, x + largeur, y + hauteur, fill=1, stroke=trait)
        elif type_objet == "guilloche":
            _guilloche(c, x, y, largeur, hauteur, _hex(obj.get("couleur"), "#FEAB00"), jeton)
        elif type_objet == "rosette":
            _rosette(c, x, y, largeur, hauteur, _hex(obj.get("couleur"), "#FFFFFF"), jeton)
        elif type_objet == "micro":
            _microtexte(c, obj, etu, jeton, edition, base, x, y, largeur, hauteur)
        elif type_objet == "ligne":
            c.setStrokeColor(_hex(obj.get("couleur"), "#1A1A1A"))
            c.setLineWidth(max(0.4, mm(float(obj.get("epaisseur") or 0.3))))
            c.line(x, y + hauteur / 2, x + largeur, y + hauteur / 2)
        elif type_objet == "image":
            marque = ROOT / "static" / ("marque-blanc.png" if obj.get("id") == "logo" else "marque.png")
            if marque.is_file():
                c.drawImage(
                    str(marque),
                    x,
                    y,
                    largeur,
                    hauteur,
                    preserveAspectRatio=True,
                    anchor="c",
                    mask="auto",
                )
        elif type_objet == "photo":
            c.saveState()
            if rayon > 0.4:
                chemin = c.beginPath()
                chemin.roundRect(x, y, largeur, hauteur, rayon)
                c.clipPath(chemin, stroke=0, fill=0)
            c._setFillAlpha(1)
            c.setFillColor(_hex(obj.get("couleur"), "#C5F0DC"))
            c.rect(x, y, largeur, hauteur, fill=1, stroke=0)
            if photo:
                _poser_couverture(c, photo, x, y, largeur, hauteur)
            elif obj.get("initiales", True):
                initiales = f"{(etu.prenom or ' ')[:1]}{(etu.nom or ' ')[:1]}".upper()
                taille_ini = min(hauteur * 0.38, 32)
                c.setFillColor(_hex(obj.get("couleur_texte"), "#0C4630"))
                c._setFillAlpha(1)
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
                c.setStrokeColor(HexColor("#FEAB00"))
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
            barre = Code128(
                propre,
                barWidth=max(0.15, facteur),
                barHeight=max(mm(2), zone_h - reserve),
                quiet=0,
                humanReadable=1 if lisible else 0,
                fontName="DejaVu",
                fontSize=6,
            )
            c.setFillColor(_hex(obj.get("fond"), "#FFFFFF"))
            c.rect(x, y, largeur, hauteur, fill=1, stroke=0)
            c.setFillColor(_hex(obj.get("couleur"), "#111111"))
            if vertical:
                c.saveState()
                c.translate(x + largeur / 2, y + hauteur / 2)
                c.rotate(90)
                barre.drawOn(c, -zone_w / 2, -zone_h / 2 + reserve)
                c.restoreState()
            else:
                barre.drawOn(c, x, y + reserve)
        elif type_objet in ("champ", "texte"):
            _ecrire_bloc(c, obj, etu, jeton, edition, base, x, y, largeur, hauteur)
    c.restoreState()


def _dessiner_verso(c, etu, photo, jeton: str, edition: int, base: str, retourner: bool) -> None:
    """Tourne le verso de 180° : après le retournement bord long de la Primacy, il est à l'endroit."""
    if retourner:
        page_w, page_h = taille_carte()
        c.saveState()
        c.translate(page_w, page_h)
        c.rotate(180)
    dessiner_face(c, "verso", etu, photo, jeton, edition, base)
    if retourner:
        c.restoreState()


def pdf_individuel(
    etu, photo: bytes, jeton: str, edition: int, base: str,
    recto_verso: bool = True, retourner_verso: bool = False,
) -> bytes:
    c, tampon = _nouveau_canvas(taille_carte(), recto_verso)
    c.setTitle(f"Carte {etu.matricule}")
    dessiner_face(c, "recto", etu, photo, jeton, edition, base)
    c.showPage()
    _dessiner_verso(c, etu, photo, jeton, edition, base, retourner_verso and recto_verso)
    c.save()
    return tampon.getvalue()


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
