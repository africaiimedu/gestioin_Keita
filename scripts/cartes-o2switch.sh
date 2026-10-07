#!/bin/bash
# Installe ou met à jour l'application Cartes sur o2switch à partir de ce dépôt.
# Usage (SSH, dossier ~/gestioin_Keita) : bash scripts/cartes-o2switch.sh
# Le code est copié dans ~/africaiim-cartes (une application cPanel ne peut pas être dans une autre).
# Les données (data/), le .env et le prix du repas réglé en ligne (config/carte.json) ne sont jamais écrasés.
set -euo pipefail

SRC="$HOME/gestioin_Keita/Afrcaiim Card/"
DEST="$HOME/africaiim-cartes/"
VENV_ACTIVATE="${CARTES_VENV:-}"

mkdir -p "$DEST" "$DEST/data/photos" "$DEST/data/courriers" "$DEST/tmp"
rsync -a --delete \
  --exclude ".env" --exclude ".venv/" --exclude "data/" --exclude "tmp/" --exclude "public/" \
  --exclude "tests/" --exclude "__pycache__/" --exclude ".pytest_cache/" --exclude "*.log" \
  --exclude ".htaccess" --exclude "Capture d*" --exclude "config/carte.json" \
  "$SRC" "$DEST"
[ -f "$DEST/config/carte.json" ] || cp "$SRC/config/carte.json" "$DEST/config/carte.json"
chmod 700 "$DEST/data"

if [ -z "$VENV_ACTIVATE" ]; then
  VENV_ACTIVATE=$(ls -d "$HOME"/virtualenv/africaiim-cartes/*/bin/activate 2>/dev/null | sort -V | tail -1 || true)
fi
if [ -n "$VENV_ACTIVATE" ] && [ -f "$VENV_ACTIVATE" ]; then
  # shellcheck disable=SC1090
  source "$VENV_ACTIVATE"
  pip install -q -r "$DEST/requirements.txt"
  touch "$DEST/tmp/restart.txt"
  echo "Application Cartes mise à jour et redémarrée."
else
  echo "Code copié. Créez l'application Python dans cPanel (racine africaiim-cartes), puis relancez ce script."
fi
