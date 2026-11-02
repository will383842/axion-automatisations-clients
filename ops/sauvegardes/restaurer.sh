#!/usr/bin/env bash
# Restaure la dernière sauvegarde dans un conteneur NEUF et imprime son nom sur la dernière ligne (à supprimer par l'appelant).
# Variables :
#   SAUVEGARDE_ESSAI    1 = essai : la phrase vient du volume d'essai (/cles) et la clé de l'hôte SFTP n'est pas vérifiée.
#                       Défaut 0 = vraie restauration (T1B-05) : la phrase vient d'OpenBao en HTTPS, la clé de l'hôte SFTP est vérifiée contre known_hosts (mode strict).
#   BAO_ADDR            (hors essai) https://hote:port, joignable depuis le réseau du serveur PostgreSQL
#   BAO_CA_FICHIER      (hors essai) autorité du réseau interne, sur la machine qui lance ce script ; montée en lecture seule dans le conteneur
#   BAO_JETON_FICHIER   (hors essai) chemin, sur la machine qui lance ce script, du fichier du jeton ; monté en lecture seule dans le conteneur
#   SFTP_KNOWN_HOSTS    (hors essai) fichier known_hosts de la cible SFTP ; défaut : known_hosts à côté de ce script (monté avec le dossier)
#   SAUVEGARDE_IMAGE    image avec pgBackRest (défaut : celle du service postgres lancé) · SAUVEGARDE_PROJET (défaut socle)
#   SAUVEGARDE_JOURNAL  dossier du journal (une ligne par essai de restauration, journaliser.sh)
# La configuration du conteneur est préparée par preparer-configuration.sh, le MÊME script que celui du serveur : un seul chemin pour « strict » + known_hosts.
# En cas d'échec, le conteneur de restauration est supprimé avant de sortir.
set -euo pipefail

dossier="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=journaliser.sh
source "$dossier/journaliser.sh"

essai="${SAUVEGARDE_ESSAI:-0}"
args_bao=()
if [ "$essai" != "1" ]; then
  [ -n "${BAO_ADDR:-}" ] || { echo "adresse d'OpenBao absente (BAO_ADDR), ou SAUVEGARDE_ESSAI=1 pour un essai" >&2; exit 1; }
  [ -n "${BAO_JETON_FICHIER:-}" ] || { echo "fichier du jeton absent (BAO_JETON_FICHIER)" >&2; exit 1; }
  [ -r "$BAO_JETON_FICHIER" ] || { echo "fichier du jeton illisible : $BAO_JETON_FICHIER" >&2; exit 1; }
  args_bao=(-e BAO_ADDR -e BAO_JETON_FICHIER -v "$BAO_JETON_FICHIER:$BAO_JETON_FICHIER:ro")
  # Autorité du réseau interne : sans elle, lire-phrase-chiffrement.sh refuse https:// ; montée au même chemin dans le conteneur.
  if [ -n "${BAO_CA_FICHIER:-}" ]; then
    [ -r "$BAO_CA_FICHIER" ] || { echo "autorité de certification illisible : $BAO_CA_FICHIER" >&2; exit 1; }
    args_bao+=(-e BAO_CA_FICHIER -v "$BAO_CA_FICHIER:$BAO_CA_FICHIER:ro")
  fi
  # Empreinte de l'hôte SFTP : known_hosts hors du dossier des scripts, monté au même chemin. Sinon celui du dossier (déjà monté).
  if [ -n "${SFTP_KNOWN_HOSTS:-}" ]; then
    [ -r "$SFTP_KNOWN_HOSTS" ] || { echo "known_hosts illisible : $SFTP_KNOWN_HOSTS" >&2; exit 1; }
    args_bao+=(-e SFTP_KNOWN_HOSTS -v "$SFTP_KNOWN_HOSTS:$SFTP_KNOWN_HOSTS:ro")
  fi
fi

projet="${SAUVEGARDE_PROJET:-socle}"
debut="$(date +%s)"
nom="restauration-$$"
reussi=0
# Le conteneur de restauration n'est gardé que si le serveur restauré répond : sur tout autre chemin de sortie, il est supprimé.
# Une ligne de journal par essai (réussi ou non) : taille de la base restaurée, mesurée dans le conteneur.
terminer() {
  local code=$? taille=0 resultat=echec
  trap - EXIT
  if [ "$reussi" = "1" ]; then
    resultat=ok
    taille="$(docker exec "$nom" du -sb /tmp/donnees 2>/dev/null | cut -f1)" || taille=0
    [[ "$taille" =~ ^[0-9]+$ ]] || taille=0
  else
    docker rm -f -v "$nom" >/dev/null 2>&1 || true
  fi
  journal_ecrire restauration ponctuelle restauration "$taille" "-" "$resultat" "$(( $(date +%s) - debut ))" "$nom" || { [ "$code" -ne 0 ] || code=1; }
  exit "$code"
}
trap terminer EXIT

source_ctr="$(docker ps -q --filter "label=com.docker.compose.project=$projet" --filter "label=com.docker.compose.service=postgres")"
[ -n "$source_ctr" ] || { echo "service postgres du projet $projet introuvable" >&2; exit 1; }
image="${SAUVEGARDE_IMAGE:-$(docker inspect -f '{{.Config.Image}}' "$source_ctr")}"
reseau="$(docker inspect -f '{{range $k, $_ := .NetworkSettings.Networks}}{{$k}} {{end}}' "$source_ctr" | cut -d' ' -f1)"
volume_cles="$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/cles"}}{{.Name}}{{end}}{{end}}' "$source_ctr")"

docker run -d --name "$nom" --network "$reseau" \
  -e SAUVEGARDE_ESSAI="$essai" "${args_bao[@]}" \
  -v "$volume_cles:/cles:ro" -v "$dossier:/opt/sauvegardes:ro" \
  --entrypoint bash "$image" -c '
    set -euo pipefail
    # Configuration en mémoire (/dev/shm), droits 0400 : le modèle plus la phrase, comme au démarrage du serveur (même script).
    # Hors essai : « strict » + known_hosts à la place de « none ». Le serveur restauré en a besoin pour relire ses journaux (restore_command) ;
    # la phrase n est que dans ce fichier : jamais dans l environnement du processus postgres.
    export PGBACKREST_CONFIG=/dev/shm/pgbackrest.conf
    /opt/sauvegardes/preparer-configuration.sh
    umask 077
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
