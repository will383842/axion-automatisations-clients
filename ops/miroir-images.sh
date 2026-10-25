#!/usr/bin/env bash
# Miroir des images (A-382) : copie chaque image inscrite dans ops/briques, par empreinte, vers le registre GHCR du compte.
# NON lancé par la CI : lancé par le chef d'orchestre. La sortie datée est la preuve (spec/preuves.md).
# Usage : MIROIR_COMPTE=<compte GHCR> ops/miroir-images.sh [--a-blanc]   (connexion GHCR déjà faite par docker login)
set -euo pipefail
cd "$(dirname "$0")/.."

mode="copie"
case "${1:-}" in
  "") ;;
  --a-blanc) mode="blanc" ;;
  *) echo "usage : ops/miroir-images.sh [--a-blanc]" >&2; exit 2 ;;
esac
compte="${MIROIR_COMPTE:-}"
if [ -z "$compte" ]; then
  [ "$mode" = "blanc" ] && compte="compte-exemple" || { echo "MIROIR_COMPTE absent" >&2; exit 2; }
fi

# --lister échoue (et la boucle ne tourne pas) si une brique ne passe pas la garde.
images="$(node scripts/garde-briques.ts --lister)"
while IFS= read -r ligne; do
  [ -n "$ligne" ] || continue
  source="${ligne%@*}"           # depot:version
  empreinte="${ligne#*@}"
  depot="${source%:*}"
  version="${source##*:}"
  destination="ghcr.io/${compte}/miroir/$(printf '%s' "$depot" | tr '/:' '--'):${version}"
  if [ "$mode" = "blanc" ]; then
    echo "À BLANC ${depot}@${empreinte} -> ${destination}"
  else
    docker buildx imagetools create --tag "$destination" "${depot}@${empreinte}"
    echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) COPIÉ ${depot}@${empreinte} -> ${destination}"
  fi
done <<< "$images"
