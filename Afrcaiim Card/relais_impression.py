#!/usr/bin/env python3
"""Relais d'impression AfricaIIM : imprime sur cet ordinateur les cartes demandées sur le site.

Installation (une fois, dans le Terminal) :
    python3 relais_impression.py --installer --adresse https://scolarite.univ-africaiim.com/portail/cartes

Le jeton est demandé sans s'afficher. Le relais démarre ensuite tout seul à chaque ouverture
de session (macOS). Il annonce toutes les imprimantes installées, prend les cartes en attente,
les imprime avec CUPS et renvoie le résultat. Le site ne se connecte jamais à cet ordinateur.

Python 3.9 et la bibliothèque standard suffisent.
"""

from __future__ import annotations

import argparse
import base64
import getpass
import json
import os
import platform
import plistlib
import shutil
import socket
import ssl
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ICI = Path(__file__).resolve().parent
sys.path.insert(0, str(ICI))
try:
    from app.services import cups
except ImportError:
    import cups  # type: ignore[no-redef]

VERSION = "1"
DOSSIER = Path.home() / "Library" / "Application Support" / "AfricaIIM" / "relais"
ETIQUETTE = "com.univ-africaiim.relais-impression"
AGENT = Path.home() / "Library" / "LaunchAgents" / f"{ETIQUETTE}.plist"
JOURNAL = Path.home() / "Library" / "Logs" / "africaiim-relais.log"
ATTENTE = 4
ANNONCE = 30


def dire(message: str) -> None:
    print(time.strftime("%Y-%m-%d %H:%M:%S"), message, flush=True)


class Relais:
    def __init__(self, adresse: str, jeton: str, certificat: Path | None = None):
        self.adresse = adresse.rstrip("/")
        self.jeton = jeton
        self.contexte = ssl.create_default_context()
        if certificat is not None and certificat.is_file():
            self.contexte.load_verify_locations(cafile=str(certificat))

    def appeler(self, chemin: str, corps: dict | None = None) -> tuple[int, dict]:
        donnees = json.dumps(corps or {}).encode()
        requete = urllib.request.Request(
            self.adresse + chemin,
            data=donnees,
            method="POST",
            headers={
                "Authorization": f"Bearer {self.jeton}",
                "Content-Type": "application/json",
                "User-Agent": f"AfricaIIM-relais/{VERSION}",
            },
        )
        try:
            with urllib.request.urlopen(requete, timeout=60, context=self.contexte) as reponse:
                brut = reponse.read()
                return reponse.status, (json.loads(brut) if brut else {})
        except urllib.error.HTTPError as erreur:
            try:
                return erreur.code, json.loads(erreur.read() or b"{}")
            except ValueError:
                return erreur.code, {}

    def annoncer(self) -> int:
        imprimantes = [
            {"nom": imp["nom"], "etat": imp["etat"], "primacy": imp["primacy"]} for imp in cups.lister_imprimantes()
        ]
        statut, reponse = self.appeler("/api/relais/annonce", {"imprimantes": imprimantes, "version": VERSION})
        if statut == 200:
            return int(reponse.get("imprimantes") or 0)
        raise PermissionError(reponse.get("message") or f"Le site a répondu {statut}.")

    def un_tour(self) -> bool:
        statut, travail = self.appeler("/api/relais/travail")
        if statut == 204:
            return False
        if statut != 200:
            raise PermissionError(travail.get("message") or f"Le site a répondu {statut}.")
        nom = str(travail.get("imprimante") or "")
        connues = {imp["nom"] for imp in cups.lister_imprimantes()}
        if nom not in connues:
            ok, message = False, f"L'imprimante {nom} n'est plus installée sur cet ordinateur."
        else:
            pdf = base64.b64decode(travail.get("pdf") or "")
            ok, message = cups.envoyer(
                pdf,
                nom,
                bool(travail.get("recto_verso")),
                int(travail.get("copies") or 1),
                str(travail.get("media") or "Custom.85.6x54mm"),
                "portrait" if travail.get("sens") == "portrait" else "paysage",
            )
        dire(f"Carte {travail.get('libelle', '')} → {nom} : {'imprimée' if ok else message}")
        self.appeler(f"/api/relais/travail/{int(travail['id'])}", {"ok": ok, "message": "" if ok else message})
        return True

    def tourner(self) -> None:
        dire(f"Relais démarré pour {self.adresse}")
        derniere = 0.0
        while True:
            try:
                if time.time() - derniere > ANNONCE:
                    nombre = self.annoncer()
                    if derniere == 0.0:
                        dire(f"{nombre} imprimante(s) annoncée(s) au site.")
                    derniere = time.time()
                if self.un_tour():
                    continue
            except PermissionError as refus:
                dire(f"Refus du site : {refus} Nouvel essai dans une minute.")
                time.sleep(60)
                continue
            except (urllib.error.URLError, socket.timeout, ConnectionError, ssl.SSLError) as panne:
                dire(f"Site injoignable : {panne}. Nouvel essai dans 15 secondes.")
                time.sleep(15)
                continue
            except Exception as autre:  # le relais ne doit jamais s'arrêter tout seul
                dire(f"Erreur inattendue : {autre!r}")
                time.sleep(15)
                continue
            time.sleep(ATTENTE)


def _lire_config() -> tuple[str, str, Path | None]:
    config = json.loads((DOSSIER / "config.json").read_text())
    jeton = (DOSSIER / "jeton").read_text().strip()
    certificat = DOSSIER / "serveur.pem"
    return config["adresse"], jeton, (certificat if certificat.is_file() else None)


def _certificat_du_site(adresse: str) -> str:
    morceaux = urllib.parse.urlsplit(adresse)
    return ssl.get_server_certificate((morceaux.hostname, morceaux.port or 443))


def installer(adresse: str) -> None:
    if platform.system() != "Darwin":
        sys.exit("L'installation automatique est prévue pour macOS. Ailleurs, lancez ce fichier au démarrage.")
    if not adresse.startswith("https://"):
        sys.exit("L'adresse du site doit commencer par https://")
    jeton = os.environ.get("RELAIS_JETON", "").strip() or getpass.getpass("Jeton du relais (il ne s'affiche pas) : ").strip()
    if len(jeton) < 32:
        sys.exit("Ce jeton est trop court. Copiez-le depuis la page Ordinateurs d'impression.")
    DOSSIER.mkdir(parents=True, exist_ok=True)
    os.chmod(DOSSIER, 0o700)
    certificat = DOSSIER / "serveur.pem"
    relais = Relais(adresse, jeton)
    try:
        nombre = relais.annoncer()
    except (urllib.error.URLError, ssl.SSLError) as erreur:
        if "CERTIFICATE_VERIFY_FAILED" not in str(erreur):
            sys.exit(f"Le site ne répond pas : {erreur}")
        certificat.write_text(_certificat_du_site(adresse))
        print("Le site utilise encore un certificat provisoire : il est enregistré sur cet ordinateur.")
        relais = Relais(adresse, jeton, certificat)
        nombre = relais.annoncer()
    except PermissionError as refus:
        sys.exit(f"Le site refuse ce jeton : {refus}")
    for fichier in ("relais_impression.py",):
        shutil.copy2(ICI / fichier, DOSSIER / fichier)
    source_cups = ICI / "app" / "services" / "cups.py"
    shutil.copy2(source_cups if source_cups.is_file() else ICI / "cups.py", DOSSIER / "cups.py")
    (DOSSIER / "config.json").write_text(json.dumps({"adresse": adresse.rstrip("/")}))
    chemin_jeton = DOSSIER / "jeton"
    chemin_jeton.write_text(jeton)
    os.chmod(chemin_jeton, 0o600)
    JOURNAL.parent.mkdir(parents=True, exist_ok=True)
    AGENT.parent.mkdir(parents=True, exist_ok=True)
    with AGENT.open("wb") as sortie:
        plistlib.dump(
            {
                "Label": ETIQUETTE,
                "ProgramArguments": ["/usr/bin/python3", str(DOSSIER / "relais_impression.py")],
                "RunAtLoad": True,
                "KeepAlive": True,
                "ThrottleInterval": 10,
                "StandardOutPath": str(JOURNAL),
                "StandardErrorPath": str(JOURNAL),
                "WorkingDirectory": str(DOSSIER),
            },
            sortie,
        )
    domaine = f"gui/{os.getuid()}"
    subprocess.run(["launchctl", "bootout", domaine, str(AGENT)], capture_output=True)
    lance = subprocess.run(["launchctl", "bootstrap", domaine, str(AGENT)], capture_output=True, text=True)
    if lance.returncode != 0:
        sys.exit(f"Le relais est installé mais n'a pas démarré : {lance.stderr.strip()}")
    print(f"Relais installé : {nombre} imprimante(s) annoncée(s). Il démarre à chaque ouverture de session.")
    print(f"Journal : {JOURNAL}")


def desinstaller() -> None:
    subprocess.run(["launchctl", "bootout", f"gui/{os.getuid()}", str(AGENT)], capture_output=True)
    AGENT.unlink(missing_ok=True)
    shutil.rmtree(DOSSIER, ignore_errors=True)
    print("Relais retiré de cet ordinateur.")


def main() -> None:
    parser = argparse.ArgumentParser(description="Relais d'impression des cartes AfricaIIM")
    parser.add_argument("--installer", action="store_true", help="installe et démarre le relais (macOS)")
    parser.add_argument("--desinstaller", action="store_true", help="arrête et retire le relais")
    parser.add_argument("--adresse", default="", help="adresse du site des cartes, en https")
    parser.add_argument("--imprimantes", action="store_true", help="affiche les imprimantes vues par cet ordinateur")
    arguments = parser.parse_args()
    if arguments.imprimantes:
        for imp in cups.lister_imprimantes():
            print(f"{imp['nom']} — {imp['etat']}{' · Primacy 2' if imp['primacy'] else ''}")
        return
    if arguments.desinstaller:
        desinstaller()
        return
    if arguments.installer:
        installer(arguments.adresse)
        return
    try:
        adresse, jeton, certificat = _lire_config()
    except (OSError, ValueError, KeyError):
        sys.exit("Relais non installé. Lancez : python3 relais_impression.py --installer --adresse https://…")
    Relais(adresse, jeton, certificat).tourner()


if __name__ == "__main__":
    main()
