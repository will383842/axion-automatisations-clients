#!/usr/bin/env bash
# Restaure la dernière sauvegarde dans un conteneur NEUF et imprime son nom sur la dernière ligne (à supprimer par l'appelant).
# Variables : SAUVEGARDE_IMAGE (image avec pgBackRest, par défaut celle du service postgres lancé), SAUVEGARDE_PROJET (défaut socle).
set -euo pipefail

projet="${SAUVEGARDE_PROJET:-socle}"
source_ctr="$(docker ps -q --filter "label=com.docker.compose.project=$projet" --filter "label=com.docker.compose.service=postgres")"
[ -n "$source_ctr" ] || { echo "service postgres du projet $projet introuvable" >&2; exit 1; }
image="${SAUVEGARDE_IMAGE:-$(docker inspect -f '{{.Config.Image}}' "$source_ctr")}"
reseau="$(docker inspect -f '{{range $k, $_ := .NetworkSettings.Networks}}{{$k}} {{end}}' "$source_ctr" | cut -d' ' -f1)"
volume_cles="$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/cles"}}{{.Name}}{{end}}{{end}}' "$source_ctr")"
dossier="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
nom="restauration-$$"

docker run -d --name "$nom" --network "$reseau" \
  -e SAUVEGARDE_ESSAI="${SAUVEGARDE_ESSAI:-1}" \
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
  if docker exec "$nom" pg_isready -q -h /var/run/postgresql; then echo "$nom"; exit 0; fi
  sleep 1
done
docker logs "$nom" >&2 || true
exit 1
