"""Imprimantes CUPS (macOS, Linux) : liste et envoi d'un PDF de carte au pilote.

Ce module n'utilise que la bibliothèque standard de Python 3.9 : le relais d'impression
installé sur l'ordinateur du bureau l'emporte tel quel.
"""

from __future__ import annotations

import re
import subprocess
import tempfile
from pathlib import Path

_NOM_IMPRIMANTE = re.compile(
    r"(?:printer|imprimante)\s+(\S+)\s+(?:is|est|disabled|désactivée|desactivee)\b",
    re.IGNORECASE,
)
_URI_IMPRIMANTE = re.compile(r"(\S+)\s*:\s*(\S+://\S+)")


def etat_imprimante(ligne: str) -> str:
    """Le Mac répond en français ou en anglais. « inactive » veut dire prête, pas arrêtée."""
    texte = ligne.lower()
    if "désactiv" in texte or "desactiv" in texte or "disabled" in texte:
        return "arrêtée"
    if "printing" in texte or "imprime" in texte or "impression" in texte:
        return "en cours"
    return "prête"


def est_primacy(nom: str, uri: str = "") -> bool:
    texte = f"{nom} {uri}".lower()
    return "primacy" in texte or "evolis" in texte


def analyser_imprimantes(etat: str, liens: str, noms: str = "") -> list[dict]:
    uris: dict[str, str] = {}
    for ligne in liens.splitlines():
        trouve = _URI_IMPRIMANTE.search(ligne)
        if trouve:
            uris[trouve.group(1)] = trouve.group(2)
    resultat = []
    vus: set[str] = set()
    for ligne in etat.splitlines():
        trouve = _NOM_IMPRIMANTE.search(ligne)
        if not trouve:
            continue
        nom = trouve.group(1)
        vus.add(nom)
        uri = uris.get(nom, "")
        resultat.append({"nom": nom, "etat": etat_imprimante(ligne), "primacy": est_primacy(nom, uri), "uri": uri})
    for ligne in noms.splitlines():
        nom = ligne.strip()
        if not nom or nom in vus:
            continue
        uri = uris.get(nom, "")
        resultat.append({"nom": nom, "etat": "prête", "primacy": est_primacy(nom, uri), "uri": uri})
    return resultat


def lister_imprimantes() -> list[dict]:
    """Toutes les imprimantes installées sur cet ordinateur (CUPS), Primacy comprise."""

    def _lire(*args: str) -> str:
        resultat = subprocess.run(
            ["lpstat", *args],
            capture_output=True, text=True, timeout=5, stdin=subprocess.DEVNULL,
        )
        return resultat.stdout or ""

    try:
        return analyser_imprimantes(_lire("-p"), _lire("-v"), _lire("-e"))
    except (OSError, subprocess.TimeoutExpired):
        return []


def choix_pilote(nom: str) -> dict[str, list[str]]:
    """Options réelles du pilote, pour ne lui envoyer que ce qu'il sait faire."""
    try:
        resultat = subprocess.run(
            ["lpoptions", "-p", nom, "-l"],
            capture_output=True, text=True, timeout=5, stdin=subprocess.DEVNULL,
        )
    except (OSError, subprocess.TimeoutExpired):
        return {}
    if resultat.returncode != 0:
        return {}
    options: dict[str, list[str]] = {}
    for ligne in resultat.stdout.splitlines():
        gauche, sep, droite = ligne.partition(":")
        if not sep or "/" not in gauche:
            continue
        cle = gauche.split("/", 1)[0].strip()
        options[cle] = [mot.lstrip("*") for mot in droite.split() if mot.strip()]
    return options


def _poser_option(commande: list[str], choix: dict[str, list[str]], cle: str, valeur: str) -> None:
    if valeur in choix.get(cle, []):
        commande += ["-o", f"{cle}={valeur}"]


def commande_lp(
    nom: str, copies: int, duplex: bool, media: str, choix: dict[str, list[str]], orientation: str = "paysage",
) -> list[str]:
    """Même orientation que la carte, couleurs RVB du fichier, sans réduire la page."""
    paysage = orientation != "portrait"
    commande = [
        "lp", "-d", nom, "-n", str(max(1, min(20, copies))),
        "-o", "fit-to-page=false",
        "-o", "print-color-mode=color",
        "-o", "print-quality=5",
        "-o", "orientation-requested=5" if paysage else "orientation-requested=3",
    ]
    if "Card" in choix.get("PageSize", []):
        commande += ["-o", "PageSize=Card"]
    elif "CR80" in choix.get("PageSize", []):
        commande += ["-o", "PageSize=CR80"]
    else:
        commande += ["-o", f"media={media}"]
    if paysage:
        _poser_option(commande, choix, "Orientation", "LANDSCAPE_CC90")
    else:
        _poser_option(commande, choix, "Orientation", "PORTRAIT")
    if duplex:
        commande += ["-o", "sides=two-sided-long-edge"]
        for cle, valeurs in choix.items():
            if "DuplexNoTumble" in valeurs:
                commande += ["-o", f"{cle}=DuplexNoTumble"]
                break
    else:
        commande += ["-o", "sides=one-sided"]
        for valeur in ("NONE", "None"):
            if valeur in choix.get("Duplex", []):
                commande += ["-o", f"Duplex={valeur}"]
                break
    for cle in ("ColorModel", "ColorMode"):
        valeurs = choix.get(cle, [])
        if "RGB" in valeurs:
            commande += ["-o", f"{cle}=RGB"]
            break
        if "Color" in valeurs:
            commande += ["-o", f"{cle}=Color"]
            break
    # 1200 dpi gonfle le fichier : le travail tarde, puis la Primacy 2 sort une carte vierge.
    for voulu in ("600dpi", "300dpi", "300x300dpi"):
        if voulu in choix.get("Resolution", []):
            commande += ["-o", f"Resolution={voulu}"]
            break
    for cle in ("cupsPrintQuality", "PrintQuality", "OutputMode"):
        for voulu in ("High", "Best", "Fine"):
            if voulu in choix.get(cle, []):
                commande += ["-o", f"{cle}={voulu}"]
                break
    for cle in ("FColorContrast", "BColorContrast"):
        _poser_option(commande, choix, cle, "VAL16")
    for cle in ("FColorBrightness", "BColorBrightness"):
        _poser_option(commande, choix, cle, "VAL10")
    _poser_option(commande, choix, "GDuplexType", "DUPLEX_CC")
    for cle in ("FHalftoning", "BHalftoning"):
        _poser_option(commande, choix, cle, "DITHERING")
    for cle in ("FBlackManagement", "BBlackManagement"):
        _poser_option(commande, choix, cle, "TEXTINBLACK")
    for cle in ("IFColorProfileMode", "IBColorProfileMode"):
        _poser_option(commande, choix, cle, "DRIVERPROFILE")
    for cle in ("IFColorProfile", "IBColorProfile"):
        _poser_option(commande, choix, cle, "STDPROFILE")
    _poser_option(commande, choix, "GSmoothing", "ADVSMOOTH")
    demi_tour = "ON" if paysage else "OFF"
    for cle in ("FPageRotate180", "BPageRotate180"):
        _poser_option(commande, choix, cle, demi_tour)
    return commande


def envoyer(pdf: bytes, nom: str, duplex: bool, copies: int, media: str, orientation: str = "paysage") -> tuple[bool, str]:
    """Envoie le PDF CR80 au pilote choisi, dans le sens demandé, sans le réduire à une page A4."""
    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as tmp:
        tmp.write(pdf)
        chemin = tmp.name
    commande = commande_lp(nom, copies, duplex, media, choix_pilote(nom), orientation)
    commande.append(chemin)
    try:
        resultat = subprocess.run(
            commande,
            capture_output=True, text=True, timeout=30, stdin=subprocess.DEVNULL,
        )
    except (OSError, subprocess.TimeoutExpired):
        return False, "Le système d'impression de l'ordinateur n'a pas répondu."
    finally:
        Path(chemin).unlink(missing_ok=True)
    if resultat.returncode != 0:
        detail = (resultat.stderr or resultat.stdout or "").strip().splitlines()
        return False, (detail[0][:180] if detail else "L'imprimante a refusé le travail.")
    return True, nom
