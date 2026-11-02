#!/usr/bin/env bash
# Imprime la phrase de chiffrement du dépôt pgBackRest, lue au moment de l'usage (C-593). Jamais écrite dans un fichier versionné.
#   Essai (SAUVEGARDE_ESSAI=1) : lue dans le fichier généré au lancement par le service cle-essai.
#   Sinon : lue dans OpenBao, chemin technique/sauvegardes, champ « phrase ».
#     BAO_ADDR            https://hote:port (T1B-04) : le certificat est vérifié (chaîne et nom) contre l'autorité du réseau interne,
#                         BAO_CA_FICHIER (obligatoire, lisible). http://hote:port est REFUSÉ, sauf BAO_ESSAI_SANS_TLS=1 (OpenBao d'essai jetable).
#     BAO_JETON_FICHIER   fichier qui contient le jeton (jamais le jeton lui-même dans l'environnement)
#     BAO_DELAI           délai maximal, en secondes, de la connexion et de la lecture (défaut 10) : un OpenBao muet fait échouer le script
#                         (code 1, message net) au lieu de bloquer le démarrage.
# Une phrase de moins de 32 caractères est refusée : la production exige au moins 32 octets aléatoires (voir README).
set -euo pipefail

if [ "${SAUVEGARDE_ESSAI:-}" = "1" ]; then
  phrase="$(cat /cles/phrase)"
else
  [ -n "${BAO_ADDR:-}" ] || { echo "adresse d'OpenBao absente (BAO_ADDR)" >&2; exit 1; }
  [ -n "${BAO_JETON_FICHIER:-}" ] || { echo "fichier du jeton absent (BAO_JETON_FICHIER)" >&2; exit 1; }
  schema=""
  case "$BAO_ADDR" in
    https://*) schema=https; hote_port="${BAO_ADDR#https://}" ;;
    http://*)
      [ "${BAO_ESSAI_SANS_TLS:-}" = "1" ] || { echo "OpenBao en http:// refusé hors essai : utiliser https:// avec BAO_CA_FICHIER" >&2; exit 1; }
      schema=http; hote_port="${BAO_ADDR#http://}" ;;
    *) echo "BAO_ADDR doit être de la forme https://hote:port" >&2; exit 1 ;;
  esac
  hote_port="${hote_port%/}"
  hote="${hote_port%%:*}"
  port="${hote_port##*:}"
  [ -n "$hote" ] && [ "$port" != "$hote_port" ] && [ -n "$port" ] || { echo "BAO_ADDR doit contenir un port : https://hote:port" >&2; exit 1; }
  if [ "$schema" = "https" ]; then
    [ -n "${BAO_CA_FICHIER:-}" ] && [ -r "$BAO_CA_FICHIER" ] || { echo "autorité de certification d'OpenBao absente ou illisible (BAO_CA_FICHIER)" >&2; exit 1; }
    command -v openssl >/dev/null 2>&1 || { echo "openssl est absent : impossible de vérifier le certificat d'OpenBao" >&2; exit 1; }
  fi
  # Tout le dialogue avec OpenBao tourne sous « timeout » : le script se relance lui-même une fois, sous délai.
  delai="${BAO_DELAI:-10}"
  case "$delai" in "" | *[!0-9]* | 0) delai=10 ;; esac
  if [ -z "${LIRE_PHRASE_SOUS_DELAI:-}" ]; then
    code=0
    LIRE_PHRASE_SOUS_DELAI=1 timeout "$delai" "${BASH_SOURCE[0]}" || code=$?
    if [ "$code" -eq 124 ] || [ "$code" -eq 137 ]; then
      echo "OpenBao n'a pas répondu en ${delai} s" >&2
      exit 1
    fi
    exit "$code"
  fi
  jeton="$(cat "$BAO_JETON_FICHIER")"
  # Fonction (pas de substitution de commande : elle retirerait le saut de ligne final et la requête resterait incomplète).
  requete() { printf 'GET /v1/technique/data/sauvegardes HTTP/1.0\r\nHost: %s\r\nX-Vault-Token: %s\r\n\r\n' "$hote" "$jeton"; }
  if [ "$schema" = "https" ]; then
    # TLS vérifié : une chaîne ou un nom qui ne passent pas coupent la connexion, la réponse reste vide et la lecture est refusée.
    reponse="$(requete | openssl s_client -quiet -connect "${hote}:${port}" -servername "$hote" -CAfile "$BAO_CA_FICHIER" -verify_return_error -verify_hostname "$hote" 2>/dev/null)" || reponse=""
  else
    # HTTP minimal par /dev/tcp (essai seulement) : l'image ne contient ni curl ni wget.
    exec 3<>"/dev/tcp/${hote}/${port}"
    requete >&3
    reponse="$(cat <&3)"
    exec 3<&-
  fi
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
