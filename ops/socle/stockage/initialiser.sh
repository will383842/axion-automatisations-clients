#!/usr/bin/env bash
# Crée les compartiments communs du stockage (exports, factures, suivi, artefacts), puis vérifie leur présence.
#   initialiser.sh [conteneur]   sans argument : le conteneur du service « stockage » du socle (projet « socle »)
# Idempotent : un compartiment présent n'est pas recréé. Aucun accès anonyme n'est ouvert : sans identité anonyme, la brique refuse toute requête non signée.
set -euo pipefail

conteneur="${1:-}"
if [ -z "$conteneur" ]; then
  conteneur="$(docker ps -q --filter label=com.docker.compose.project=socle --filter label=com.docker.compose.service=stockage | head -n 1)"
fi
[ -n "$conteneur" ] || { echo "conteneur du stockage introuvable" >&2; exit 1; }

coquille() { docker exec -i "$conteneur" weed shell -master=localhost:9333; }
liste() { printf 's3.bucket.list\n' | coquille 2>&1; }

existants="$(liste)"
for c in exports factures suivi artefacts; do
  if ! printf '%s\n' "$existants" | grep -qw -- "$c"; then
    printf 's3.bucket.create -name %s\n' "$c" | coquille > /dev/null
  fi
done

existants="$(liste)"
for c in exports factures suivi artefacts; do
  printf '%s\n' "$existants" | grep -qw -- "$c" || { echo "compartiment $c absent" >&2; exit 1; }
done
echo "compartiments communs présents : exports factures suivi artefacts"
