#!/usr/bin/env bash
# Restaure la dernière sauvegarde dans un conteneur NEUF et imprime son nom sur la dernière ligne (à supprimer par l'appelant).
# Variables :
#   SAUVEGARDE_ESSAI    1 = essai : la phrase vient du volume d'essai (/cles). Défaut 0 = vraie restauration : la phrase vient d'OpenBao.
#   BAO_ADDR            (hors essai) adresse d'OpenBao, http://hote:port, joignable depuis le réseau du serveur PostgreSQL
#   BAO_JETON_FICHIER   (hors essai) chemin, sur la machine qui lance ce script, du fichier du jeton ; monté en lecture seule dans le conteneur
#   SAUVEGARDE_IMAGE    image avec pgBackRest (défaut : celle du service postgres lancé) · SAUVEGARDE_PROJET (défaut socle)
# En cas d'échec, le conteneur de restauration est supprimé avant de sortir.
set -euo pipefail

essai="${SAUVEGARDE_ESSAI:-0}"
args_bao=()
if [ "$essai" != "1" ]; then
  [ -n "${BAO_ADDR:-}" ] || { echo "adresse d'OpenBao absente (BAO_ADDR), ou SAUVEGARDE_ESSAI=1 pour un essai" >&2; exit 1; }
  [ -n "${BAO_JETON_FICHIER:-}" ] || { echo "fichier du jeton absent (BAO_JETON_FICHIER)" >&2; exit 1; }
  [ -r "$BAO_JETON_FICHIER" ] || { echo "fichier du jeton illisible : $BAO_JETON_FICHIER" >&2; exit 1; }
  args_bao=(-e BAO_ADDR -e BAO_JETON_FICHIER -v "$BAO_JETON_FICHIER:$BAO_JETON_FICHIER:ro")
fi

projet="${SAUVEGARDE_PROJET:-socle}"
source_ctr="$(docker ps -q --filter "label=com.docker.compose.project=$projet" --filter "label=com.docker.compose.service=postgres")"
[ -n "$source_ctr" ] || { echo "service postgres du projet $projet introuvable" >&2; exit 1; }
image="${SAUVEGARDE_IMAGE:-$(docker inspect -f '{{.Config.Image}}' "$source_ctr")}"
reseau="$(docker inspect -f '{{range $k, $_ := .NetworkSettings.Networks}}{{$k}} {{end}}' "$source_ctr" | cut -d' ' -f1)"
volume_cles="$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/cles"}}{{.Name}}{{end}}{{end}}' "$source_ctr")"
dossier="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
nom="restauration-$$"

# Le conteneur de restauration n'est gardé que si le serveur restauré répond : sur tout autre chemin de sortie, il est supprimé.
reussi=0
nettoyer() { if [ "$reussi" != "1" ]; then docker rm -f -v "$nom" >/dev/null 2>&1 || true; fi; }
trap nettoyer EXIT

docker run -d --name "$nom" --network "$reseau" \
  -e SAUVEGARDE_ESSAI="$essai" "${args_bao[@]}" \
  -v "$volume_cles:/cles:ro" -v "$dossier:/opt/sauvegardes:ro" \
  --entrypoint bash "$image" -c '
    set -euo pipefail
    export PGBACKREST_REPO1_CIPHER_PASS="$(/opt/sauvegardes/lire-phrase-chiffrement.sh)"
    export PGBACKREST_CONFIG=/tmp/pgbackrest.conf
    cp /opt/sauvegardes/pgbackrest.conf.modele "$PGBACKREST_CONFIG"
    mkdir -p /tmp/donnees && chmod 700 /tmp/donnees
    pgbackrest --stanza=commun --pg1-path=/tmp/donnees --type=immediate --target-action=promote restore
    exec postgres -D /tmp/donnees -c archive_mode=off -c listen_addresses= -c unix_socket_directories=/var/run/postgresql
  ' >/dev/null

# Contrôle : le serveur restauré répond, sinon la restauration a échoué.
for _ in $(seq 1 120); do
  if docker exec "$nom" pg_isready -q -h /var/run/postgresql; then
    reussi=1
    echo "$nom"
    exit 0
  fi
  # Conteneur déjà arrêté : la restauration a échoué, inutile d'attendre le reste du délai.
  [ "$(docker inspect -f '{{.State.Running}}' "$nom" 2>/dev/null || echo false)" = "true" ] || break
  sleep 1
done
docker logs "$nom" >&2 || true
echo "la restauration n'a pas abouti (serveur restauré muet ou arrêté)" >&2
exit 1
