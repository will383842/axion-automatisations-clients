#!/usr/bin/env bash
# Copie les artefacts de modules (compartiment « artefacts », T1A-11) vers la cible de sauvegarde (A-192).
# Usage : copier-artefacts.sh <source> <cible>
# Ajout seul : un fichier déjà copié n'est jamais remplacé, et rien n'est jamais supprimé sur la cible, même si la source perd le fichier.
set -euo pipefail

source_dir="${1:?dossier source absent}"
cible="${2:?dossier cible absent}"
[ -d "$source_dir" ] && [ -d "$cible" ] || { echo "source ou cible introuvable" >&2; exit 1; }
cp -a -n "$source_dir"/. "$cible"/
