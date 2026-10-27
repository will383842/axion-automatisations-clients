#!/usr/bin/env bash
# Imprime la phrase de chiffrement du dépôt pgBackRest, lue au moment de l'usage (C-593). Jamais écrite dans un fichier versionné.
#   Essai (SAUVEGARDE_ESSAI=1) : lue dans le fichier généré au lancement par le service cle-essai.
#   Sinon : lue dans OpenBao, chemin technique/sauvegardes, champ « phrase ».
#     BAO_ADDR            adresse sous la même forme que ops/socle/litellm/demarrer.sh : http://hote:port (le HTTPS n'est pas pris en charge ici)
#     BAO_JETON_FICHIER   fichier qui contient le jeton (jamais le jeton lui-même dans l'environnement)
# Une phrase de moins de 32 caractères est refusée : la production exige au moins 32 octets aléatoires (voir README).
set -euo pipefail

if [ "${SAUVEGARDE_ESSAI:-}" = "1" ]; then
  phrase="$(cat /cles/phrase)"
else
  [ -n "${BAO_ADDR:-}" ] || { echo "adresse d'OpenBao absente (BAO_ADDR)" >&2; exit 1; }
  [ -n "${BAO_JETON_FICHIER:-}" ] || { echo "fichier du jeton absent (BAO_JETON_FICHIER)" >&2; exit 1; }
  case "$BAO_ADDR" in
    https://*) echo "OpenBao en HTTPS : non pris en charge par ce script (TLS ou réseau dédié, lot 1-B)" >&2; exit 1 ;;
    http://*) ;;
    *) echo "BAO_ADDR doit être de la forme http://hote:port" >&2; exit 1 ;;
  esac
  hote_port="${BAO_ADDR#http://}"
  hote_port="${hote_port%/}"
  hote="${hote_port%%:*}"
  port="${hote_port##*:}"
  [ -n "$hote" ] && [ "$port" != "$hote_port" ] && [ -n "$port" ] || { echo "BAO_ADDR doit contenir un port : http://hote:port" >&2; exit 1; }
  jeton="$(cat "$BAO_JETON_FICHIER")"
  # HTTP minimal par /dev/tcp : l'image ne contient ni curl ni wget.
  exec 3<>"/dev/tcp/${hote}/${port}"
  printf 'GET /v1/technique/data/sauvegardes HTTP/1.0\r\nHost: %s\r\nX-Vault-Token: %s\r\n\r\n' "$hote" "$jeton" >&3
  reponse="$(cat <&3)"
  exec 3<&-
  saut=$'\n'
  retour=$'\r'
  statut="${reponse%%"$saut"*}"
  statut="${statut%"$retour"}"
  case "$statut" in
    *" 200 "*) ;;
    *) echo "OpenBao a refusé la lecture : ${statut:-aucune réponse}" >&2; exit 1 ;;
  esac
  # JSON avec ou sans espaces autour des deux-points.
  motif='s/.*"phrase" *: *"\([^"]*\)".*/\1/p'
  phrase="$(printf '%s' "$reponse" | sed -n "$motif" | head -n 1)"
fi

[ -n "$phrase" ] || { echo "phrase de chiffrement introuvable" >&2; exit 1; }
[ "${#phrase}" -ge 32 ] || { echo "phrase de chiffrement trop courte (32 caractères au moins)" >&2; exit 1; }
printf '%s\n' "$phrase"
