#!/usr/bin/env bash
# Expiration des sauvegardes complètes, pilotée par retention.ts (C-049) : 30 quotidiennes et 12 mensuelles.
#   expirer.sh              lit la liste réelle (pgbackrest info), calcule, puis fait expirer chaque ensemble désigné (pgbackrest expire --set)
#   expirer.sh --simuler    imprime les identifiants qui seraient expirés, sans rien supprimer
# Tourne sur l'HÔTE (il faut Node 22.18 ou plus, pour lancer retention.ts sans option, et docker), après sauvegarder-nuit.sh. pgBackRest n'a aucune rétention automatique (9999 complètes) :
# tant que ce script n'a pas tourné, rien n'est jamais effacé.
# Variables : SAUVEGARDE_PROJET (défaut socle) · EXPIRER_AUJOURDHUI (AAAA-MM-JJ UTC, pour les essais ; défaut : date du jour UTC).
# Sur une cible en AJOUT SEUL, « pgbackrest expire » échoue : le script sort alors en erreur (voir README, lot 1-B).
set -euo pipefail

simuler=0
case "${1:-}" in
  "") ;;
  --simuler) simuler=1 ;;
  *) echo "usage : expirer.sh [--simuler]" >&2; exit 2 ;;
esac

projet="${SAUVEGARDE_PROJET:-socle}"
ctr="$(docker ps -q --filter "label=com.docker.compose.project=$projet" --filter "label=com.docker.compose.service=postgres")"
[ -n "$ctr" ] || { echo "service postgres du projet $projet introuvable" >&2; exit 1; }
dossier="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
aujourdhui="${EXPIRER_AUJOURDHUI:-$(date -u +%Y-%m-%d)}"

# La phrase est lue dans le conteneur, par le même script que la sauvegarde : elle ne passe jamais par l'hôte.
dans() { docker exec "$ctr" sh -c 'PGBACKREST_REPO1_CIPHER_PASS="$(/opt/sauvegardes/lire-phrase-chiffrement.sh)" && export PGBACKREST_REPO1_CIPHER_PASS && exec "$@"' sh "$@"; }

info="$(dans pgbackrest --stanza=commun info --output=json)"
a_expirer="$(printf '%s' "$info" | node "$dossier/retention.ts" "$aujourdhui")"

if [ -z "$a_expirer" ]; then
  echo "rien à expirer" >&2
  exit 0
fi
while IFS= read -r id; do
  if [ "$simuler" = "1" ]; then
    echo "$id"
  else
    dans pgbackrest --stanza=commun "--set=$id" expire
    echo "expiré : $id" >&2
  fi
done <<<"$a_expirer"
