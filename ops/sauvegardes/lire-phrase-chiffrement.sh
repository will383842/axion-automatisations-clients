#!/usr/bin/env bash
# Imprime la phrase de chiffrement du dépôt pgBackRest, lue au moment de l'usage (C-593). Jamais écrite dans un fichier versionné.
#   Essai (SAUVEGARDE_ESSAI=1) : lue dans le fichier généré au lancement par le service cle-essai.
#   Sinon : lue dans OpenBao, chemin technique/sauvegardes, champ « phrase » ; adresse dans BAO_ADDR (hôte:port, HTTP interne),
#   jeton dans le fichier nommé par BAO_JETON_FICHIER.
set -euo pipefail

if [ "${SAUVEGARDE_ESSAI:-}" = "1" ]; then
  cat /cles/phrase
  exit 0
fi

: "${BAO_ADDR:?adresse OpenBao absente}" "${BAO_JETON_FICHIER:?fichier du jeton absent}"
hote="${BAO_ADDR%%:*}"
port="${BAO_ADDR##*:}"
jeton="$(cat "$BAO_JETON_FICHIER")"
# HTTP minimal par /dev/tcp : l'image ne contient ni curl ni wget.
exec 3<>"/dev/tcp/${hote}/${port}"
printf 'GET /v1/technique/data/sauvegardes HTTP/1.0\r\nHost: %s\r\nX-Vault-Token: %s\r\n\r\n' "$hote" "$jeton" >&3
reponse="$(cat <&3)"
exec 3<&-
motif='s/.*"phrase" *: *"\([^"]*\)".*/\1/p'
phrase="$(printf '%s' "$reponse" | sed -n "$motif" | head -n 1)"
[ -n "$phrase" ] || { echo "phrase de chiffrement introuvable dans OpenBao" >&2; exit 1; }
printf '%s\n' "$phrase"
