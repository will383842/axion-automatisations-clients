#!/bin/sh
# Refuse de tourner en root, quelle que soit l'option du compose (ADR 0104).
set -eu
if [ "$(id -u)" = "0" ]; then
  echo "axion-moteur : démarrage en root refusé" >&2
  exit 1
fi
exec "$@"
