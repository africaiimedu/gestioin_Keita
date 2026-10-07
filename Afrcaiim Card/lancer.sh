#!/bin/zsh
set -e
cd "$(dirname "$0")"

if [ ! -d .venv ]; then
  python3 -m venv .venv
  .venv/bin/pip install -r requirements.txt
fi

if [ ! -f fonts/DejaVuSans.ttf ]; then
  mkdir -p fonts
  tmp=$(mktemp)
  curl -fsSL -o "$tmp" \
    https://github.com/dejavu-fonts/dejavu-fonts/releases/download/version_2_37/dejavu-fonts-ttf-2.37.zip
  for f in DejaVuSans.ttf DejaVuSans-Bold.ttf DejaVuSans-Oblique.ttf DejaVuSans-BoldOblique.ttf \
    DejaVuSerif.ttf DejaVuSerif-Bold.ttf DejaVuSerif-Italic.ttf DejaVuSerif-BoldItalic.ttf; do
    unzip -p "$tmp" "dejavu-fonts-ttf-2.37/ttf/$f" > "fonts/$f"
  done
  rm -f "$tmp"
fi

docker compose up -d
echo "Attente de PostgreSQL..."
for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
  if docker compose exec -T db pg_isready -U africard -d africard >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

exec .venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000
