"""Mots de passe et jetons de carte. Rien ici n'est devinable."""

from __future__ import annotations

import base64
import hashlib
import secrets

_TOURS = 200_000
_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"


def hash_mot_de_passe(mot_de_passe: str) -> str:
    sel = secrets.token_bytes(16)
    derive = hashlib.pbkdf2_hmac("sha256", mot_de_passe.encode("utf-8"), sel, _TOURS)
    return "pbkdf2_sha256$%s$%s$%s" % (
        _TOURS,
        base64.b64encode(sel).decode(),
        base64.b64encode(derive).decode(),
    )


def verifier_mot_de_passe(mot_de_passe: str, stocke: str) -> bool:
    if not mot_de_passe or len(mot_de_passe) > 200:
        return False
    try:
        algo, tours, sel_b64, hash_b64 = stocke.split("$")
        if algo != "pbkdf2_sha256":
            return False
        sel = base64.b64decode(sel_b64)
        attendu = base64.b64decode(hash_b64)
        derive = hashlib.pbkdf2_hmac(
            "sha256", mot_de_passe.encode("utf-8"), sel, int(tours)
        )
        return secrets.compare_digest(derive, attendu)
    except (ValueError, TypeError):
        return False


def mot_de_passe_temporaire() -> str:
    return "".join(secrets.choice(_ALPHABET) for _ in range(12))


def nouveau_jeton() -> str:
    return secrets.token_urlsafe(32)
