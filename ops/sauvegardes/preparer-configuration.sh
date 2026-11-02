#!/usr/bin/env bash
# Appelé UNE FOIS au démarrage du conteneur PostgreSQL, avant le serveur (compose.sauvegardes.yml).
# Lit la phrase de chiffrement (lire-phrase-chiffrement.sh), puis écrit la configuration pgBackRest dans PGBACKREST_CONFIG
# (tmpfs, droits 0400, propriétaire postgres) : le modèle plus la phrase. archive_command n'appelle plus OpenBao à chaque segment :
# si OpenBao tombe après le démarrage, l'archivage continue et pg_wal ne se remplit pas. Voir README, « File d'archivage ».
# Échoue bruyamment (le conteneur ne démarre pas) si le modèle n'est pas unique, si la phrase est illisible,
# ou si, hors essai, l'empreinte de l'hôte SFTP n'est pas épinglée (known_hosts).
set -euo pipefail

dossier="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cible="${PGBACKREST_CONFIG:?destination de la configuration absente}"
case "$cible" in /dev/shm/*) ;; *) echo "la configuration (avec la phrase) doit être sur un tmpfs : /dev/shm/..., pas $cible" >&2; exit 1 ;; esac

modeles=("$dossier"/pgbackrest.conf.*)
{ [ "${#modeles[@]}" -eq 1 ] && [ -f "${modeles[0]}" ]; } || { echo "un seul modèle pgbackrest.conf.* est attendu dans $dossier (trouvés : ${#modeles[@]})" >&2; exit 1; }
modele="${modeles[0]}"

# Hors essai : l'hôte SFTP est vérifié contre une empreinte épinglée (known_hosts), jamais « none » ni « accept-new » (pas de confiance au premier contact).
# Le modèle garde « none » pour la cible d'essai ; la copie en mémoire le remplace par « strict » + known_hosts.
hors_essai=0
known_hosts=""
if [ "${SAUVEGARDE_ESSAI:-}" != "1" ]; then
  hors_essai=1
  # Port SFTP autre que 22 : la ligne du fichier doit être de la forme « [hote]:port type clé » (sinon l'hôte est refusé).
  known_hosts="${SFTP_KNOWN_HOSTS:-$dossier/known_hosts}"
  if [ ! -s "$known_hosts" ] || ! grep -Evq '^[[:space:]]*(#|$)' "$known_hosts"; then
    echo "hors essai, l'empreinte de l'hôte SFTP doit être épinglée : known_hosts absent ou sans clé ($known_hosts ; modèle : known_hosts.modele)" >&2
    exit 1
  fi
fi

phrase="$("$dossier/lire-phrase-chiffrement.sh")"
[ -n "$phrase" ] || { echo "phrase de chiffrement vide" >&2; exit 1; }

umask 277
rm -f "$cible"
{
  printf '[global]\nrepo1-cipher-pass=%s\n' "$phrase"
  if [ "$hors_essai" = "1" ]; then
    printf 'repo1-sftp-host-key-check-type=strict\nrepo1-sftp-known-host=%s\n' "$known_hosts"
    grep -Ev '^\[global\]$|^[[:space:]]*repo1-sftp-host-key-(check|hash)-type[[:space:]]*=' "$modele"
  else
    grep -v '^\[global\]$' "$modele"
  fi
} >"$cible"
