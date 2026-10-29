#!/usr/bin/env bash
# Expiration des sauvegardes complètes, pilotée par retention.ts (C-049) : 30 quotidiennes et 12 mensuelles.
#   expirer.sh              lit la liste réelle (pgbackrest info), calcule, puis fait expirer chaque ensemble désigné (pgbackrest expire --set)
#   expirer.sh --simuler    imprime les identifiants qui seraient expirés, sans rien supprimer
# Tourne sur l'HÔTE (il faut Node 22.18 ou plus et docker), après sauvegarder-nuit.sh. pgBackRest n'a aucune rétention automatique (9999 complètes) :
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

# Node 22.18 ou plus : avant, « node retention.ts » ne s'exécute pas sans option. Refus net avant toute commande docker.
version_node="$(node --version 2>/dev/null || true)"
version_node="${version_node#v}"
majeur="${version_node%%.*}"
reste="${version_node#*.}"
mineur="${reste%%.*}"
case "$majeur$mineur" in
  "" | *[!0-9]*) echo "expirer.sh : Node 22.18 ou plus est requis (version trouvée : ${version_node:-aucune})" >&2; exit 1 ;;
esac
if [ "$majeur" -lt 22 ] || { [ "$majeur" -eq 22 ] && [ "$mineur" -lt 18 ]; }; then
  echo "expirer.sh : Node 22.18 ou plus est requis (version trouvée : $version_node)" >&2
  exit 1
fi

projet="${SAUVEGARDE_PROJET:-socle}"
ctr="$(docker ps -q --filter "label=com.docker.compose.project=$projet" --filter "label=com.docker.compose.service=postgres")"
[ -n "$ctr" ] || { echo "service postgres du projet $projet introuvable" >&2; exit 1; }
dossier="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
aujourdhui="${EXPIRER_AUJOURDHUI:-$(date -u +%Y-%m-%d)}"

# La phrase est lue dans le conteneur, par le même script que la sauvegarde : elle ne passe jamais par l'hôte.
dans() { docker exec "$ctr" sh -c 'PGBACKREST_REPO1_CIPHER_PASS="$(/opt/sauvegardes/lire-phrase-chiffrement.sh)" && export PGBACKREST_REPO1_CIPHER_PASS && exec "$@"' sh "$@"; }

info="$(dans pgbackrest --stanza=commun info --output=json)"
# Échec net : si le calcul refuse (sauvegarde trop ancienne, sortie inattendue), rien n'est expiré.
a_expirer="$(printf '%s' "$info" | node "$dossier/retention.ts" "$aujourdhui")" || { echo "expiration annulée : aucune sauvegarde n'a été expirée" >&2; exit 1; }

if [ -z "$a_expirer" ]; then
  echo "rien à expirer" >&2
  exit 0
fi
while IFS= read -r id; do
  if [ "$simuler" = "1" ]; then
    echo "$id"
  else
    dans pgbackrest --stanza=commun "--set=$id" expire || { echo "échec de l'expiration de $id : arrêt, les ensembles suivants ne sont pas expirés" >&2; exit 1; }
    echo "expiré : $id" >&2
  fi
done <<<"$a_expirer"
