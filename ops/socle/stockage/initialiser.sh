#!/usr/bin/env bash
# Crée les compartiments communs du stockage (exports, factures, suivi, artefacts), puis vérifie leur présence.
#   initialiser.sh [conteneur]   sans argument : le conteneur du service « stockage » du socle (projet « socle »)
# Le compartiment journal-audit (copie quotidienne du journal d'audit, T2-10) est créé avec le verrouillage d'objets ACTIVÉ À LA CRÉATION :
# on ne l'ajoute pas après coup. Il n'a pas d'utilisateur par client : seule la plateforme y dépose, en mode COMPLIANCE.
# Idempotent : un compartiment présent n'est pas recréé. Aucun accès anonyme n'est ouvert : sans identité anonyme, la brique refuse toute requête non signée.
set -euo pipefail

conteneur="${1:-}"
if [ -z "$conteneur" ]; then
  conteneur="$(docker ps -q --filter label=com.docker.compose.project=socle --filter label=com.docker.compose.service=stockage | head -n 1)"
fi
[ -n "$conteneur" ] || { echo "conteneur du stockage introuvable" >&2; exit 1; }

coquille() { docker exec -i "$conteneur" weed shell -master=localhost:9333; }
liste() { printf 's3.bucket.list\n' | coquille 2>&1; }
# Nom exact : « journal-audit-ancien » ne vaut pas « journal-audit ».
present() { printf '%s\n' "$2" | tr -s ' \t' '\n\n' | grep -qx -- "$1"; }

existants="$(liste)"
for c in exports factures suivi artefacts; do
  if ! present "$c" "$existants"; then
    printf 's3.bucket.create -name %s\n' "$c" | coquille > /dev/null
  fi
done

if ! present journal-audit "$existants"; then
  printf 's3.bucket.create -name journal-audit -withLock\n' | coquille > /dev/null
fi

existants="$(liste)"
for c in exports factures suivi artefacts journal-audit; do
  present "$c" "$existants" || { echo "compartiment $c absent" >&2; exit 1; }
done
echo "compartiments communs présents : exports factures suivi artefacts journal-audit"
