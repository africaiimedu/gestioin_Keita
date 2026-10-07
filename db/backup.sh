#!/bin/sh
# Sauvegarde complète de la base (format pg_dump personnalisé), à intervalle régulier.
# Les fichiers vont dans data/backups sur la machine hôte ; les plus anciens sont supprimés.
set -eu

INTERVAL="${BACKUP_INTERVAL_SECONDS:-86400}"
KEEP="${BACKUP_KEEP_DAYS:-30}"

until pg_isready -q; do sleep 2; done

while true; do
  file="/backups/africaiim_$(date +%Y-%m-%d_%H-%M).dump"
  if pg_dump --format=custom --file="$file.tmp"; then
    mv "$file.tmp" "$file"
    echo "Sauvegarde : $file"
  else
    rm -f "$file.tmp"
    echo "Échec de la sauvegarde" >&2
  fi
  find /backups -name 'africaiim_*.dump' -mtime +"$KEEP" -delete
  sleep "$INTERVAL"
done
