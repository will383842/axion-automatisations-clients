#!/usr/bin/env bash
# Copie les artefacts de modules (compartiment « artefacts » du stockage, T1A-11) vers la cible de sauvegarde (A-192).
#   copier-artefacts.sh --compartiment <conteneur-stockage> <cible>   lit le VRAI compartiment « artefacts » (service stockage du socle)
#   copier-artefacts.sh <dossier-source> <cible>                      copie un dossier (export du compartiment, ou essai)
# Ajout seul : un fichier déjà présent sur la cible n'est jamais remplacé (test d'existence explicite, le code de retour ne dépend pas
# de la version de cp), et rien n'est jamais supprimé sur la cible, même si la source perd le fichier. Relançable sans erreur.
# Compartiment : lu par l'interface HTTP du filer de SeaweedFS DEPUIS le conteneur (wget, réseau interne), sous /buckets/artefacts.
# Les noms d'objets sont supposés sans espace ni caractère spécial d'URL (noms de modules).
# Chaque fichier est d'abord écrit sous un nom provisoire puis renommé : une copie interrompue ou une lecture en échec
# ne laisse jamais un fichier tronqué que la relance prendrait pour complet.
set -euo pipefail

COMPARTIMENT="artefacts"
mode="dossier"
if [ "${1:-}" = "--compartiment" ]; then
  mode="compartiment"
  shift
fi
origine="${1:?source absente}"
cible="${2:?dossier cible absent}"
[ -d "$cible" ] || { echo "cible introuvable : $cible" >&2; exit 1; }
provisoire="$cible/.copie-en-cours.$$"
trap 'rm -f "$provisoire"' EXIT

# Refus net (A-192) d'un chemin relatif qui sort de la cible : « .. » comme élément, ou chemin absolu. Rien n'est écrit.
verifier_chemin() {
  case "$1" in
    "" | /* | .. | ../* | */.. | */../*) echo "chemin refusé (« .. » ou chemin absolu) : $1" >&2; exit 1 ;;
  esac
}

# $1 : chemin relatif sur la cible ; le fichier provisoire est complet, on le range à sa place.
ranger() {
  mkdir -p "$(dirname "$cible/$1")"
  mv "$provisoire" "$cible/$1"
}

if [ "$mode" = "dossier" ]; then
  [ -d "$origine" ] || { echo "source introuvable : $origine" >&2; exit 1; }
  while IFS= read -r -d '' f; do
    rel="${f#"$origine"/}"
    verifier_chemin "$rel"
    if [ -e "$cible/$rel" ]; then continue; fi
    cp -p "$f" "$provisoire"
    ranger "$rel"
  done < <(find "$origine" -type f -print0)
else
  filer() { docker exec "$origine" wget -q -O - "$@"; }
  parcourir() { # $1 : chemin relatif dans le compartiment ('' = racine)
    local liste entree chemin rel mode_fichier
    liste="$(filer --header 'Accept: application/json' "http://localhost:8888/buckets/$COMPARTIMENT/${1:+$1/}?limit=100000")"
    while IFS= read -r entree; do
      chemin="$(printf '%s' "$entree" | sed -n 's/.*"FullPath":"\([^"]*\)".*/\1/p')"
      [ -n "$chemin" ] || continue
      rel="${chemin#/buckets/$COMPARTIMENT/}"
      case "$rel" in .uploads | .uploads/*) continue ;; esac
      verifier_chemin "$rel"
      mode_fichier="$(printf '%s' "$entree" | sed -n 's/.*"Mode":\([0-9]*\).*/\1/p')"
      if [ -n "$mode_fichier" ] && (( mode_fichier & 2147483648 )); then
        parcourir "$rel"
      elif [ ! -e "$cible/$rel" ]; then
        filer "http://localhost:8888/buckets/$COMPARTIMENT/$rel" >"$provisoire"
        ranger "$rel"
      fi
    done < <(printf '%s\n' "$liste" | sed 's/},{/}\n{/g')
  }
  parcourir ""
fi
