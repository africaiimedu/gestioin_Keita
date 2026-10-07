"""Réglages lus dans .env et dans config/carte.json."""

from __future__ import annotations

import json
import os
import re
from functools import lru_cache
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[1]
load_dotenv(ROOT / ".env")

_HEX = re.compile(r"^#[0-9A-Fa-f]{6}$")
_COULEURS_DEFAUT = {
    "vert": "#004C22",
    "or": "#FEAB00",
    "gris": "#3E4742",
    "gris_clair": "#E7E2D8",
    "creme": "#F4F1EA",
    "blanc": "#FFFFFF",
}


def env(nom: str, defaut: str = "") -> str:
    return os.environ.get(nom, defaut).strip()


def base_url() -> str:
    return env("BASE_URL", "http://127.0.0.1:8000").rstrip("/")


def database_url() -> str:
    return env(
        "DATABASE_URL",
        "postgresql+psycopg://africard:africard@127.0.0.1:5432/africard",
    )


def secret_session() -> str:
    secret = env("SECRET_SESSION")
    if len(secret) < 16:
        raise RuntimeError(
            "SECRET_SESSION est absent ou trop court dans le fichier .env "
            "(16 caractères minimum)."
        )
    return secret


def charger_config() -> dict:
    with open(ROOT / "config" / "carte.json", encoding="utf-8") as fichier:
        cfg = json.load(fichier)
    couleurs = dict(_COULEURS_DEFAUT)
    for cle, valeur in (cfg.get("couleurs") or {}).items():
        if isinstance(valeur, str) and _HEX.match(valeur):
            couleurs[cle] = valeur
    cfg["couleurs"] = couleurs
    cfg.setdefault("universite", "Université")
    cfg.setdefault("etablissement", "AFRICAIIM")
    cfg.setdefault("institut", "Université AFRICAIIM")
    cfg.setdefault("mention_recto", "Carte d'étudiant")
    cfg.setdefault(
        "mention_perte",
        "Carte personnelle et non cessible. En cas de perte, contactez le +224 620 11 13 13.",
    )
    cfg["nfc"] = bool(cfg.get("nfc"))
    cfg["code_barres"] = bool(cfg.get("code_barres"))
    try:
        prix = int(cfg.get("prix_repas", 10000))
    except (TypeError, ValueError):
        prix = 10000
    cfg["prix_repas"] = min(5_000_000, max(1, prix))
    return cfg


def definir_prix_repas(montant: int) -> None:
    chemin = ROOT / "config" / "carte.json"
    cfg = json.loads(chemin.read_text(encoding="utf-8"))
    cfg["prix_repas"] = int(montant)
    chemin.write_text(json.dumps(cfg, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def chemin_logo(cfg: dict | None = None) -> Path | None:
    cfg = cfg or charger_config()
    brut = (cfg.get("logo") or "").strip()
    if not brut:
        return None
    chemin = (ROOT / brut).resolve()
    racine = ROOT.resolve()
    if racine not in chemin.parents and chemin != racine:
        return None
    if chemin.suffix.lower() not in {".png", ".jpg", ".jpeg"}:
        return None
    if not chemin.is_file():
        return None
    return chemin


@lru_cache
def polices() -> tuple[Path, Path]:
    candidats = [
        (
            ROOT / "fonts" / "DejaVuSans.ttf",
            ROOT / "fonts" / "DejaVuSans-Bold.ttf",
        ),
        (
            Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"),
            Path("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"),
        ),
        (
            Path("/System/Library/Fonts/Supplemental/Arial.ttf"),
            Path("/System/Library/Fonts/Supplemental/Arial Bold.ttf"),
        ),
    ]
    for regulier, gras in candidats:
        if regulier.is_file() and gras.is_file():
            return regulier, gras
    raise RuntimeError(
        "Police introuvable. Lancez ./lancer.sh : il télécharge DejaVu dans le dossier fonts/."
    )
