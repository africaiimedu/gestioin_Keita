"""Photos : contrôle, recadrage portrait, enregistrement."""

from __future__ import annotations

import io
import zipfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont, ImageOps

from app.config import ROOT

Image.MAX_IMAGE_PIXELS = 30_000_000

_DOSSIER = ROOT / "data" / "photos"
_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}
_FORMATS = {"JPEG", "PNG", "WEBP", "MPO"}
POIDS_MAX = 25_000_000


def _en_rgb(image: Image.Image) -> Image.Image:
    """Ramène JPG, PNG (palette, 16 bits, transparence) ou WebP en RGB sur fond clair."""
    if image.mode in ("I;16", "I;16B", "I;16L", "I;16N", "I"):
        image = image.convert("I").point(lambda v: v * (1 / 256)).convert("L")
    elif image.mode == "F":
        image = image.convert("L")
    if image.mode in ("RGBA", "LA", "PA", "RGBa", "La") or "transparency" in image.info:
        image = image.convert("RGBA")
        fond = Image.new("RGB", image.size, (244, 241, 234))
        fond.paste(image, mask=image.getchannel("A"))
        return fond
    return image.convert("RGB")


def normaliser_photo(blob: bytes) -> bytes:
    if len(blob) > POIDS_MAX:
        raise ValueError("Photo trop lourde (maximum 25 Mo).")
    try:
        Image.open(io.BytesIO(blob)).verify()
        image = Image.open(io.BytesIO(blob))
        if image.format not in _FORMATS:
            raise ValueError(image.format)
        image.load()
    except Image.DecompressionBombError as exc:
        raise ValueError("Photo trop grande en pixels. Réduisez-la sous 60 mégapixels.") from exc
    except Exception as exc:
        raise ValueError("Ce fichier n'est pas une image lisible (JPG, PNG ou WebP).") from exc

    image = _en_rgb(ImageOps.exif_transpose(image))

    if image.width < 150 or image.height < 150:
        raise ValueError("Photo trop petite. Il faut au moins 150 pixels de côté.")

    ratio = 3 / 4
    largeur, hauteur = image.size
    if largeur / hauteur > ratio:
        nouvelle = int(hauteur * ratio)
        gauche = (largeur - nouvelle) // 2
        image = image.crop((gauche, 0, gauche + nouvelle, hauteur))
    else:
        nouvelle = int(largeur / ratio)
        haut = (hauteur - nouvelle) // 2
        image = image.crop((0, haut, largeur, haut + nouvelle))

    image = image.resize((1200, 1600), Image.Resampling.LANCZOS)
    sortie = io.BytesIO()
    image.save(sortie, format="JPEG", quality=95, subsampling=0, optimize=True)
    return sortie.getvalue()


def portrait_initiales(prenom: str, nom: str) -> bytes:
    image = Image.new("RGB", (600, 800), (0, 76, 34))
    dessin = ImageDraw.Draw(image)
    dessin.ellipse((150, 180, 450, 480), fill=(254, 171, 0))
    initiales = ((prenom[:1] + nom[:1]).upper() or "AI")
    try:
        police = ImageFont.truetype(str(ROOT / "fonts" / "DejaVuSans-Bold.ttf"), 140)
    except OSError:
        police = ImageFont.load_default()
    boite = dessin.textbbox((0, 0), initiales, font=police)
    x = (600 - (boite[2] - boite[0])) / 2
    y = 260
    dessin.text((x, y), initiales, fill=(0, 76, 34), font=police)
    sortie = io.BytesIO()
    image.save(sortie, format="JPEG", quality=90)
    return sortie.getvalue()


def enregistrer_photo(etudiant_id: int, jpeg: bytes) -> str:
    _DOSSIER.mkdir(parents=True, exist_ok=True)
    chemin = _DOSSIER / f"{etudiant_id}.jpg"
    chemin.write_bytes(jpeg)
    return f"data/photos/{etudiant_id}.jpg"


def lire_photo(photo_chemin: str | None) -> bytes | None:
    if not photo_chemin:
        return None
    chemin = (ROOT / photo_chemin).resolve()
    dossier = _DOSSIER.resolve()
    if dossier not in chemin.parents:
        return None
    if not chemin.is_file():
        return None
    return chemin.read_bytes()


def photos_depuis_zip(blob: bytes) -> dict[str, bytes]:
    if len(blob) > 100_000_000:
        raise ValueError("Le ZIP dépasse 100 Mo.")
    try:
        archive = zipfile.ZipFile(io.BytesIO(blob))
    except zipfile.BadZipFile as exc:
        raise ValueError("Le fichier photos n'est pas un ZIP valide.") from exc

    resultat: dict[str, bytes] = {}
    total = 0
    with archive:
        fichiers = [info for info in archive.infolist() if not info.is_dir()]
        if len(fichiers) > 300:
            raise ValueError("Le ZIP contient trop de fichiers (maximum 300).")
        for info in fichiers:
            if info.file_size > POIDS_MAX:
                raise ValueError(f"{Path(info.filename).name} dépasse 25 Mo.")
            total += info.file_size
            if total > 250_000_000:
                raise ValueError("Le contenu décompressé du ZIP dépasse 250 Mo.")
            nom = Path(info.filename).name
            if not nom or nom.startswith("."):
                continue
            if Path(nom).suffix.lower() not in _EXTENSIONS:
                continue
            resultat[Path(nom).stem.upper()] = archive.read(info)
    return resultat
