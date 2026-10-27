#!/usr/bin/env bash
# Copie les artefacts de modules (compartiment « artefacts », T1A-11) vers la cible de sauvegarde (A-192).
# Usage : copier-artefacts.sh <source> <cible>
# Ajout seul : un fichier déjà copié n'est jamais remplacé, et rien n'est jamais supprimé sur la cible, même si la source perd le fichier.
# Le code de sortie ne dépend pas de la version de « cp » : la boucle ne copie que les fichiers absents de la cible.
set -euo pipefail

source_dir="${1:?dossier source absent}"
cible="${2:?dossier cible absent}"
[ -d "$source_dir" ] && [ -d "$cible" ] || { echo "source ou cible introuvable" >&2; exit 1; }

while IFS= read -r -d '' fichier; do
  relatif="${fichier#"$source_dir"/}"
  if [ ! -e "$cible/$relatif" ]; then
    mkdir -p "$(dirname "$cible/$relatif")"
    cp -p "$fichier" "$cible/$relatif"
  fi
done < <(find "$source_dir" -type f -print0)
