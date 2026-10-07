"""Limite simple pour éviter qu'on devine des cartes en rafale."""

from __future__ import annotations

import time

_seaux: dict[str, list[float]] = {}


def autoriser(cle: str, maximum: int, fenetre_secondes: int) -> bool:
    maintenant = time.time()
    liste = [moment for moment in _seaux.get(cle, []) if maintenant - moment < fenetre_secondes]
    if len(_seaux) > 5000:
        _seaux.clear()
        liste = []
    if len(liste) >= maximum:
        _seaux[cle] = liste
        return False
    liste.append(maintenant)
    _seaux[cle] = liste
    return True
