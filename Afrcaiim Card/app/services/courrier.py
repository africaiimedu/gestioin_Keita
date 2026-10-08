"""E-mail de débit cantine, envoyé à l'adresse professionnelle de la carte."""

from __future__ import annotations

import smtplib
from email.message import EmailMessage
from pathlib import Path

from app.config import ROOT, env


def formater_francs(montant: int) -> str:
    """Montant en francs guinéens, séparateur des milliers à point : 10.000 GNF."""
    nombre = f"{abs(int(montant)):,}".replace(",", ".")
    signe = "−" if int(montant) < 0 else ""
    return f"{signe}{nombre} GNF"


def message_debit(prenom: str, nom: str, montant: int, solde: int) -> tuple[str, str]:
    sujet = f"Cantine — débit de {formater_francs(montant)}"
    corps = (
        f"Bonjour {prenom} {nom},\n\n"
        "Votre repas à la cantine de l'Université AFRICAIIM vient d'être validé.\n"
        f"Vous avez été débité de {formater_francs(montant)} (francs guinéens).\n"
        f"Il vous reste {formater_francs(solde)} sur votre compte cantine.\n\n"
        "Université AFRICAIIM\n"
    )
    return sujet, corps


def expedier_debit(destinataire: str, prenom: str, nom: str, montant: int, solde: int) -> bool:
    """Envoie le message. Retourne False si aucun serveur n'est configuré ou s'il ne répond pas."""
    sujet, corps = message_debit(prenom, nom, montant, solde)
    _conserver(destinataire, sujet, corps)
    hote = env("SMTP_HOST")
    if not hote:
        return False
    message = EmailMessage()
    message["Subject"] = sujet
    message["From"] = env("SMTP_FROM", "Université AFRICAIIM <noreply@africaiim.edu.gn>")
    message["To"] = destinataire
    message.set_content(corps)
    port = int(env("SMTP_PORT", "587") or "587")
    try:
        with smtplib.SMTP(hote, port, timeout=12) as smtp:
            if env("SMTP_TLS", "1") != "0":
                smtp.starttls()
            utilisateur = env("SMTP_USER")
            if utilisateur:
                smtp.login(utilisateur, env("SMTP_PASSWORD"))
            smtp.send_message(message)
    except (OSError, smtplib.SMTPException, ValueError):
        return False
    return True


def _conserver(destinataire: str, sujet: str, corps: str) -> None:
    dossier = ROOT / "data" / "courriers"
    dossier.mkdir(parents=True, exist_ok=True)
    fichiers = sorted(dossier.glob("*.txt"))
    if len(fichiers) > 400:
        for ancien in fichiers[:50]:
            ancien.unlink(missing_ok=True)
    nom = f"{destinataire.replace('@', '_at_')[:40]}"
    (dossier / f"{nom}.txt").write_text(f"À : {destinataire}\nObjet : {sujet}\n\n{corps}", encoding="utf-8")
