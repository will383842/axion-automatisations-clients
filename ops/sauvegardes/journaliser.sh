#!/usr/bin/env bash
# Journal de chaque passage (T1B-05, S-4) et nom de rangement unique. Ce fichier se SOURCE : « source "$dossier/journaliser.sh" ».
#
# Nom de rangement : <système>/<quoi>/<fréquence>/<système>-<quoi>-<fréquence>-<AAAAMMJJ-HHMMSS>.<ext>
#   système : console · quoi : sauvegarde, effacement ou restauration · fréquence : quotidienne, hebdomadaire ou ponctuelle · ext : journal
#   Un seul endroit par système et par usage ; rangement_nom_valide refuse tout autre nom (échec fermé).
#
# Journal : UNE ligne par passage, champs séparés par une tabulation :
#   date (UTC, ISO 8601) · type de copie (full, diff, effacement, restauration) · taille (octets) · empreinte (sha256:<hex>) ·
#   résultat (ok ou echec) · durée (secondes) · identifiant (label pgBackRest, liste d'ensembles effacés, ou « aucun » / « - »)
#   L'empreinte désigne la copie : sha256 de « <stanza>/<label>/<taille> » (le contenu du dépôt est chiffré, il n'est pas hachable ici) ;
#   « - » quand elle n'a pas d'objet (passage en échec, restauration).
# Dossier : SAUVEGARDE_JOURNAL, sinon <dossier des scripts>/journal (essai dans un conteneur : un dossier sous /tmp, le dossier des scripts y est monté en lecture seule).
# Aucun secret dans une ligne : ni phrase, ni jeton, ni adresse.

RANGEMENT_SYSTEME="console"
RANGEMENT_QUOI=(sauvegarde effacement restauration)
RANGEMENT_FREQUENCES=(quotidienne hebdomadaire ponctuelle)

_dans_liste() { local v="$1"; shift; local x; for x in "$@"; do [ "$x" = "$v" ] && return 0; done; return 1; }

# rangement_nom_valide <chemin relatif au dossier du journal> : code 0 seulement si le chemin suit le format.
rangement_nom_valide() {
  local chemin="${1:-}" systeme quoi frequence fichier reste
  [ -n "$chemin" ] || return 1
  case "$chemin" in /* | *..* | *$'\n'* | *' '*) return 1 ;; esac
  IFS=/ read -r systeme quoi frequence fichier reste <<<"$chemin"
  [ -z "$reste" ] && [ -n "$fichier" ] || return 1
  [ "$systeme" = "$RANGEMENT_SYSTEME" ] || return 1
  _dans_liste "$quoi" "${RANGEMENT_QUOI[@]}" || return 1
  _dans_liste "$frequence" "${RANGEMENT_FREQUENCES[@]}" || return 1
  [[ "$fichier" =~ ^console-([a-z]+)-([a-z]+)-[0-9]{8}-[0-9]{6}\.journal$ ]] || return 1
  [ "${BASH_REMATCH[1]}" = "$quoi" ] && [ "${BASH_REMATCH[2]}" = "$frequence" ]
}

# journal_dossier : dossier racine du journal.
journal_dossier() {
  if [ -n "${SAUVEGARDE_JOURNAL:-}" ]; then
    printf '%s\n' "$SAUVEGARDE_JOURNAL"
  elif [ "${SAUVEGARDE_ESSAI:-}" = "1" ]; then
    printf '%s\n' "${TMPDIR:-/tmp}/journal-sauvegardes-essai"
  else
    printf '%s\n' "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/journal"
  fi
}

# empreinte_de <texte> : sha256:<hex> du texte.
empreinte_de() { printf 'sha256:%s\n' "$(printf '%s' "$1" | sha256sum | cut -d' ' -f1)"; }

# journal_ecrire <quoi> <fréquence> <type> <taille> <empreinte> <résultat> <durée> <identifiant>
# Écrit UNE ligne dans un fichier neuf (jamais d'écrasement). Code 1 et message si le nom ou une valeur est refusé, ou si l'écriture échoue.
journal_ecrire() {
  local quoi="${1:-}" frequence="${2:-}" type="${3:-}" taille="${4:-}" empreinte="${5:-}" resultat="${6:-}" duree="${7:-}" identifiant="${8:-}"
  local date_iso horodatage chemin dossier fichier
  _dans_liste "$quoi" "${RANGEMENT_QUOI[@]}" || { echo "journal : usage « $quoi » hors liste" >&2; return 1; }
  _dans_liste "$frequence" "${RANGEMENT_FREQUENCES[@]}" || { echo "journal : fréquence « $frequence » hors liste" >&2; return 1; }
  [[ "$taille" =~ ^[0-9]+$ ]] || { echo "journal : taille non numérique" >&2; return 1; }
  [[ "$duree" =~ ^[0-9]+$ ]] || { echo "journal : durée non numérique" >&2; return 1; }
  case "$resultat" in ok | echec) ;; *) echo "journal : résultat « $resultat » hors liste (ok, echec)" >&2; return 1 ;; esac
  local valeur
  for valeur in "$type" "$empreinte" "$identifiant"; do
    case "$valeur" in "" | *$'\t'* | *$'\n'*) echo "journal : valeur vide ou avec tabulation" >&2; return 1 ;; esac
  done
  date_iso="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  horodatage="$(date -u +%Y%m%d-%H%M%S)"
  chemin="$RANGEMENT_SYSTEME/$quoi/$frequence/$RANGEMENT_SYSTEME-$quoi-$frequence-$horodatage.journal"
  rangement_nom_valide "$chemin" || { echo "journal : nom de rangement refusé : $chemin" >&2; return 1; }
  dossier="$(journal_dossier)"
  fichier="$dossier/$chemin"
  (
    umask 077
    mkdir -p "$(dirname "$fichier")" || exit 1
    set -o noclobber
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$date_iso" "$type" "$taille" "$empreinte" "$resultat" "$duree" "$identifiant" >"$fichier"
  ) || { echo "journal : écriture impossible dans $dossier" >&2; return 1; }
}
