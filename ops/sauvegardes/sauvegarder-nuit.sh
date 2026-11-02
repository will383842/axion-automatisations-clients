#!/usr/bin/env bash
# Sauvegarde de nuit de la grappe commune (A-190), chiffrée avant de quitter le serveur (C-046, C-593).
# S'exécute dans le conteneur PostgreSQL. « check » avant la première sauvegarde : sans lui, l'archivage échoue sans bruit.
# La phrase est relue À CHAQUE sauvegarde (échec visible si OpenBao est injoignable) et AVANT toute commande pgBackRest (A-196).
# Rythme (C-049) : une complète par semaine, des différences les autres nuits. SAUVEGARDE_TYPE = auto (défaut), full ou diff ;
#   auto = complète le jour SAUVEGARDE_JOUR_COMPLETE (1 = lundi … 7 = dimanche, défaut 7, UTC) ou quand aucune complète n'existe encore.
# L'expiration n'est PAS faite ici (T1B-05) : « pgbackrest backup » lance sinon son propre expire, qui échoue sur une cible en ajout seul.
# --no-expire-auto la coupe ; expirer.sh (sur l'hôte, compte distinct) est l'UNIQUE tâche d'effacement (C-049).
# Une ligne de journal par passage (journaliser.sh), réussi ou non.
set -euo pipefail

dossier="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=journaliser.sh
source "$dossier/journaliser.sh"

demande="${SAUVEGARDE_TYPE:-auto}"
case "$demande" in auto | full | diff) ;; *) echo "SAUVEGARDE_TYPE doit valoir auto, full ou diff (reçu : $demande)" >&2; exit 2 ;; esac
jour_complete="${SAUVEGARDE_JOUR_COMPLETE:-7}"
case "$jour_complete" in [1-7]) ;; *) echo "SAUVEGARDE_JOUR_COMPLETE doit valoir de 1 à 7" >&2; exit 2 ;; esac

debut="$(date +%s)"
type="$demande"
resultat=echec
taille=0
empreinte="-"
identifiant="-"

# Une ligne au journal à la sortie, quelle qu'elle soit. Le code de sortie d'origine est gardé ; une écriture impossible
# ne cache jamais un échec, et fait échouer une sauvegarde réussie (le journal alimente le résumé du matin).
journaliser() {
  local code=$?
  trap - EXIT
  local frequence=quotidienne
  [ "$type" = "full" ] && frequence=hebdomadaire
  [ "$type" = "auto" ] && type="-"
  journal_ecrire sauvegarde "$frequence" "$type" "$taille" "$empreinte" "$resultat" "$(( $(date +%s) - debut ))" "$identifiant" || { [ "$code" -ne 0 ] || code=1; }
  exit "$code"
}
trap journaliser EXIT

PGBACKREST_REPO1_CIPHER_PASS="$("$dossier/lire-phrase-chiffrement.sh")"
export PGBACKREST_REPO1_CIPHER_PASS

if [ "$demande" = "auto" ]; then
  type=diff
  # Aucune complète (stanza neuve ou illisible) : la première sauvegarde est une complète. Le jour désigné aussi.
  if [ "$(date -u +%u)" = "$jour_complete" ] || ! pgbackrest --stanza=commun info --output=json 2>/dev/null | grep -Eq '"type" *: *"full"'; then
    type=full
  fi
fi

pgbackrest --stanza=commun stanza-create
pgbackrest --stanza=commun check
pgbackrest --stanza=commun "--type=$type" --no-expire-auto backup

# Dernière sauvegarde saine : label, taille de la base. Le JSON de pgBackRest est lu par PostgreSQL lui-même (aucun outil de plus dans l'image).
info="$(pgbackrest --stanza=commun info --output=json)"
ligne="$(psql -U postgres -d postgres -v "j=$info" -tA -F $'\t' <<'SQL'
select b->>'label', b#>>'{info,size}', b->>'type'
from jsonb_array_elements(:'j'::jsonb) s, jsonb_array_elements(s->'backup') b
where s->>'name' = 'commun' and coalesce((b->>'error')::boolean, false) = false
order by (b#>>'{timestamp,stop}')::bigint desc
limit 1
SQL
)"
IFS=$'\t' read -r label octets genre <<<"$ligne"
[[ "${octets:-}" =~ ^[0-9]+$ ]] && [ -n "${label:-}" ] && [ -n "${genre:-}" ] || { echo "sauvegarde faite, mais sa ligne n'a pas pu être lue dans pgbackrest info" >&2; exit 1; }
taille="$octets"
type="$genre"
identifiant="$label"
empreinte="$(empreinte_de "commun/$label/$octets")"
resultat=ok
