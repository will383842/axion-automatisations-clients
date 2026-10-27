#!/bin/sh
# Mesure l'occupation du volume des données et des journaux en attente, une ligne JSON par appel.
# Lancé à intervalle par le serveur ; au lot 1-B, aussi par la sonde extérieure.
# Usage : surveiller-disque.sh <dossier-des-données> <dossier-des-journaux-en-attente>
set -eu
donnees="${1:?dossier des données manquant}"
journaux="${2:?dossier des journaux en attente manquant}"
# df en blocs de 1 Ko : utilisé et disponible. Total = utilisé + disponible, sans l'espace réservé à root.
set -- $(df -Pk "$donnees" | awk 'NR==2 {print $3, $4}')
utilises=$(( $1 * 1024 ))
total=$(( ($1 + $2) * 1024 ))
attente=$(( $(du -sk "$journaux" | awk '{print $1}') * 1024 ))
printf '{"t":%s000,"utilises":%s,"total":%s,"journauxEnAttente":%s}\n' "$(date +%s)" "$utilises" "$total" "$attente"
