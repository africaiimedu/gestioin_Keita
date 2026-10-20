"""Designs importés (Photoshop, Illustrator, Canva…) pour l'atelier cartes."""

from __future__ import annotations

import io
import json
import re
import secrets
from datetime import datetime, timezone
from pathlib import Path

from PIL import Image, ImageOps

from app.config import ROOT

Image.MAX_IMAGE_PIXELS = 40_000_000

_DOSSIER = ROOT / "data" / "designs"
_INDEX = _DOSSIER / "index.json"
_FORMATS = {"JPEG", "PNG", "WEBP", "TIFF", "MPO"}
_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".tif", ".tiff"}
POIDS_MAX = 20_000_000
COTE_MAX = 3600
_ID = re.compile(r"^[a-zA-Z0-9_-]{8,40}$")


def _maintenant() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def assurer_dossier() -> Path:
    _DOSSIER.mkdir(parents=True, exist_ok=True)
    if not _INDEX.is_file():
        _INDEX.write_text("[]\n", encoding="utf-8")
    return _DOSSIER


def _lire_index() -> list[dict]:
    assurer_dossier()
    try:
        data = json.loads(_INDEX.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    return data if isinstance(data, list) else []


def _ecrire_index(lignes: list[dict]) -> None:
    assurer_dossier()
    _INDEX.write_text(json.dumps(lignes, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def lister_designs() -> list[dict]:
    return sorted(_lire_index(), key=lambda item: item.get("cree_le") or "", reverse=True)


def chemin_design(design_id: str) -> Path | None:
    if not _ID.match(design_id or ""):
        return None
    for extension in (".png", ".jpg", ".jpeg", ".webp"):
        chemin = _DOSSIER / f"{design_id}{extension}"
        if chemin.is_file():
            return chemin
    return None


def fiche_design(design_id: str) -> dict | None:
    for item in _lire_index():
        if item.get("id") == design_id:
            return item
    return None


def url_design(design_id: str) -> str:
    return f"/admin/designs/{design_id}"


def chemin_asset_image(obj: dict) -> Path | None:
    """Fichier à dessiner pour un objet « image » du modèle."""
    asset = str((obj or {}).get("asset") or "marque")
    if asset.startswith("design:"):
        return chemin_design(asset.split(":", 1)[1])
    if (obj or {}).get("id") == "logo":
        blanc = ROOT / "static" / "marque-blanc.png"
        if blanc.is_file():
            return blanc
    marque = ROOT / "static" / "marque.png"
    return marque if marque.is_file() else None


def normaliser_design(blob: bytes, nom_fichier: str = "") -> tuple[bytes, str, int, int]:
    """Conserve la transparence PNG ; sinon JPEG. Redimensionne si trop grand."""
    if len(blob) > POIDS_MAX:
        raise ValueError("Fichier trop lourd (maximum 20 Mo).")
    extension = Path(nom_fichier or "").suffix.lower()
    if extension and extension not in _EXTENSIONS:
        raise ValueError("Formats acceptés : PNG, JPG, WebP ou TIFF (exportez depuis Photoshop).")
    try:
        Image.open(io.BytesIO(blob)).verify()
        image = Image.open(io.BytesIO(blob))
        if image.format not in _FORMATS:
            raise ValueError(image.format or "?")
        image.load()
    except Image.DecompressionBombError as exc:
        raise ValueError("Image trop grande en pixels. Réduisez-la sous 40 mégapixels.") from exc
    except Exception as exc:
        raise ValueError("Ce fichier n'est pas une image lisible. Exportez en PNG ou JPG depuis Photoshop.") from exc

    image = ImageOps.exif_transpose(image)
    if image.width < 80 or image.height < 80:
        raise ValueError("Image trop petite (au moins 80 pixels de côté).")

    if max(image.size) > COTE_MAX:
        image.thumbnail((COTE_MAX, COTE_MAX), Image.Resampling.LANCZOS)

    sortie = io.BytesIO()
    if image.mode in ("RGBA", "LA", "PA") or "transparency" in image.info:
        image = image.convert("RGBA")
        image.save(sortie, format="PNG", optimize=True)
        return sortie.getvalue(), "png", image.width, image.height

    image = image.convert("RGB")
    image.save(sortie, format="JPEG", quality=92, subsampling=0, optimize=True)
    return sortie.getvalue(), "jpg", image.width, image.height


def enregistrer_design(blob: bytes, nom_affiche: str = "", nom_fichier: str = "") -> dict:
    contenu, extension, largeur, hauteur = normaliser_design(blob, nom_fichier)
    design_id = secrets.token_urlsafe(12).replace("-", "").replace("_", "")[:16]
    assurer_dossier()
    chemin = _DOSSIER / f"{design_id}.{extension}"
    chemin.write_bytes(contenu)
    nom = (nom_affiche or Path(nom_fichier or "").stem or "Design").strip()[:80] or "Design"
    fiche = {
        "id": design_id,
        "nom": nom,
        "fichier": chemin.name,
        "largeur": largeur,
        "hauteur": hauteur,
        "format": extension,
        "cree_le": _maintenant(),
    }
    lignes = _lire_index()
    lignes.append(fiche)
    _ecrire_index(lignes)
    return fiche


def supprimer_design(design_id: str) -> bool:
    if not _ID.match(design_id or ""):
        return False
    chemin = chemin_design(design_id)
    if chemin and chemin.is_file():
        chemin.unlink(missing_ok=True)
    lignes = [item for item in _lire_index() if item.get("id") != design_id]
    _ecrire_index(lignes)
    return True


def asset_valide(asset: str | None) -> bool:
    valeur = str(asset or "marque")
    if valeur in ("marque", "marque-blanc"):
        return True
    if valeur.startswith("design:"):
        return chemin_design(valeur.split(":", 1)[1]) is not None
    return False
