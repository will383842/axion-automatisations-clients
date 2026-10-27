#!/usr/bin/env bash
# Appelé UNE FOIS au démarrage du conteneur PostgreSQL, avant le serveur (compose.sauvegardes.yml).
# Lit la phrase de chiffrement (lire-phrase-chiffrement.sh), puis écrit la configuration pgBackRest dans PGBACKREST_CONFIG
# (tmpfs, droits 0400, propriétaire postgres) : le modèle plus la phrase. archive_command n'appelle plus OpenBao à chaque segment :
# si OpenBao tombe après le démarrage, l'archivage continue et pg_wal ne se remplit pas. Voir README, « File d'archivage ».
# Échoue bruyamment (le conteneur ne démarre pas) si le modèle n'est pas unique, si la phrase est illisible,
# ou si, hors essai, la clé de l'hôte SFTP n'est pas vérifiée.
set -euo pipefail

dossier="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cible="${PGBACKREST_CONFIG:?destination de la configuration absente}"
case "$cible" in /dev/shm/*) ;; *) echo "la configuration (avec la phrase) doit être sur un tmpfs : /dev/shm/..., pas $cible" >&2; exit 1 ;; esac

modeles=("$dossier"/pgbackrest.conf.*)
{ [ "${#modeles[@]}" -eq 1 ] && [ -f "${modeles[0]}" ]; } || { echo "un seul modèle pgbackrest.conf.* est attendu dans $dossier (trouvés : ${#modeles[@]})" >&2; exit 1; }
modele="${modeles[0]}"

if [ "${SAUVEGARDE_ESSAI:-}" != "1" ] && grep -Eq '^[[:space:]]*repo1-sftp-host-key-check-type[[:space:]]*=[[:space:]]*none' "$modele"; then
  echo "host-key-check-type=none n'est admis qu'en essai (SAUVEGARDE_ESSAI=1) : épingler l'empreinte de l'hôte SFTP" >&2
  exit 1
fi

phrase="$("$dossier/lire-phrase-chiffrement.sh")"
[ -n "$phrase" ] || { echo "phrase de chiffrement vide" >&2; exit 1; }

umask 277
rm -f "$cible"
{
  printf '[global]\nrepo1-cipher-pass=%s\n' "$phrase"
  grep -v '^\[global\]$' "$modele"
} >"$cible"
