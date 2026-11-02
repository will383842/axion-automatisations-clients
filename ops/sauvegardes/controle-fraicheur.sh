#!/usr/bin/env bash
# Contrôle séparé de la sauvegarde (T1B-05, C-602) : il lit l'ÂGE de la dernière sauvegarde valide, pas le résultat de la tâche de nuit.
# Une nuit où la tâche ne s'est pas lancée est donc détectée aussi. Lancé par sa propre minuterie (planification.modele), sur l'hôte.
# Trois alertes, par la commande ALERTE_COMMANDE (le port « Alertes » du lot 1-A ; branchée en vrai en T1B-07) appelée ainsi :
#   "$ALERTE_COMMANDE" <type> <niveau> "<message en français>"      niveau : reveil (réveille la nuit, règle de T5-06) ou matin (résumé du matin, T5-42)
#   sauvegarde_absente · sauvegarde_en_retard · sauvegarde_illisible   (reveil)  aucune sauvegarde valide / la dernière a plus de 26 heures / la liste est illisible
#   stockage_sauvegarde_plein                                          (matin)   stockage de sauvegarde à 80 % ou plus
#   effacement_en_retard                                               (matin)   expirer.sh n'a pas réussi depuis 2 nuits (pas lancé, ou en échec)
# Un message ne porte jamais de client, d'adresse ni de nom d'hôte.
# Sortie : 0 si tout est dit (alertes envoyées comprises) ; 1 si une alerte n'a pas pu partir, si une mesure manque ou si la liste est illisible.
# Variables :
#   ALERTE_COMMANDE           exécutable qui envoie l'alerte (obligatoire dès qu'une alerte part ; absente = échec visible, jamais le silence)
#   CONTROLE_INFO_FICHIER     fichier « pgbackrest info --output=json » (essai, ou lecture distante) ; sinon lu dans le conteneur postgres de SAUVEGARDE_PROJET (défaut socle)
#   CONTROLE_MAINTENANT       secondes depuis l'époque (essai) ; défaut : maintenant
#   STOCKAGE_UTILISE_OCTETS, STOCKAGE_TOTAL_OCTETS   occupation du stockage de sauvegarde, fournie par l'hôte (mesure réelle : T1B-09)
#   SEUIL_STOCKAGE_POURCENT   défaut 80 [À DÉFINIR : valeur de production fixée en T8A-10]
#   SEUIL_FRAICHEUR_HEURES    défaut 26 · SEUIL_EFFACEMENT_NUITS défaut 2 · SAUVEGARDE_JOURNAL (journal d'effacement lu ici)
set -euo pipefail

dossier="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=journaliser.sh
source "$dossier/journaliser.sh"

maintenant="${CONTROLE_MAINTENANT:-$(date +%s)}"
seuil_heures="${SEUIL_FRAICHEUR_HEURES:-26}"
seuil_stockage="${SEUIL_STOCKAGE_POURCENT:-80}"
nuits="${SEUIL_EFFACEMENT_NUITS:-2}"
[[ "$maintenant" =~ ^[0-9]+$ ]] || { echo "CONTROLE_MAINTENANT doit être un nombre de secondes" >&2; exit 2; }
[[ "$seuil_heures" =~ ^[0-9]+$ ]] && [ "$seuil_heures" -gt 0 ] || { echo "SEUIL_FRAICHEUR_HEURES doit être un entier positif" >&2; exit 2; }
[[ "$nuits" =~ ^[0-9]+$ ]] && [ "$nuits" -gt 0 ] || { echo "SEUIL_EFFACEMENT_NUITS doit être un entier positif" >&2; exit 2; }
[[ "$seuil_stockage" =~ ^[0-9]+([.][0-9]+)?$ ]] || { echo "SEUIL_STOCKAGE_POURCENT doit être un nombre" >&2; exit 2; }

erreur=0
# alerter <type> <niveau> <message> : sans commande d'alerte, ou si elle échoue, le contrôle échoue (jamais un silence).
alerter() {
  local type="$1" niveau="$2" message="$3" code=0
  if [ -z "${ALERTE_COMMANDE:-}" ]; then
    echo "ALERTE_COMMANDE absente : alerte $type non envoyée ($message)" >&2
    erreur=1
    return 0
  fi
  "$ALERTE_COMMANDE" "$type" "$niveau" "$message" || code=$?
  if [ "$code" -ne 0 ]; then
    echo "la commande d'alerte a échoué (code $code) pour $type" >&2
    erreur=1
  fi
}

# 1. La liste des sauvegardes.
if [ -n "${CONTROLE_INFO_FICHIER:-}" ]; then
  info="$(cat "$CONTROLE_INFO_FICHIER")"
else
  projet="${SAUVEGARDE_PROJET:-socle}"
  ctr="$(docker ps -q --filter "label=com.docker.compose.project=$projet" --filter "label=com.docker.compose.service=postgres")"
  if [ -z "$ctr" ]; then
    info=""
  else
    # La phrase est lue dans le conteneur, comme pour la sauvegarde : elle ne passe jamais par l'hôte.
    info="$(docker exec "$ctr" sh -c 'PGBACKREST_REPO1_CIPHER_PASS="$(/opt/sauvegardes/lire-phrase-chiffrement.sh)" && export PGBACKREST_REPO1_CIPHER_PASS && exec "$@"' sh pgbackrest --stanza=commun info --output=json)" || info=""
  fi
fi

# « ok <arrêt de la dernière sauvegarde valide ou -> <arrêt de la plus ancienne ou -> » ou « illisible » (une sauvegarde en erreur ne compte pas).
resume="$(printf '%s' "$info" | node -e '
const fs = require("node:fs");
const fin = (t) => { console.log(t); process.exit(0); };
let j;
try { j = JSON.parse(fs.readFileSync(0, "utf8")); } catch { fin("illisible"); }
if (!Array.isArray(j)) fin("illisible");
const arrets = [];
for (const g of j) {
  if (g === null || typeof g !== "object") fin("illisible");
  if (g.backup === undefined || g.backup === null) continue;
  if (!Array.isArray(g.backup)) fin("illisible");
  for (const b of g.backup) {
    if (b === null || typeof b !== "object") fin("illisible");
    if (b.error === true) continue;
    const arret = b.timestamp && b.timestamp.stop;
    if (typeof arret !== "number") fin("illisible");
    arrets.push(arret);
  }
}
if (arrets.length === 0) fin("ok - -");
fin("ok " + Math.max(...arrets) + " " + Math.min(...arrets));
' 2>/dev/null || echo illisible)"
read -r etat derniere premiere <<<"$resume"

if [ "$etat" != "ok" ]; then
  alerter sauvegarde_illisible reveil "L'état des sauvegardes n'a pas pu être lu : la fraîcheur ne peut pas être vérifiée."
  erreur=1
elif [ "$derniere" = "-" ]; then
  alerter sauvegarde_absente reveil "Aucune sauvegarde valide n'existe."
else
  age=$(( maintenant - derniere ))
  if [ "$age" -gt $(( seuil_heures * 3600 )) ]; then
    alerter sauvegarde_en_retard reveil "La dernière sauvegarde valide a plus de ${seuil_heures} heures (âge : $(( age / 3600 )) h)."
  fi
fi

# 2. Le stockage de sauvegarde (mesure fournie par l'hôte).
utilise="${STOCKAGE_UTILISE_OCTETS:-}"
total="${STOCKAGE_TOTAL_OCTETS:-}"
if [[ "$utilise" =~ ^[0-9]+$ ]] && [[ "$total" =~ ^[0-9]+$ ]] && [ "$total" -gt 0 ] && [ "$utilise" -le "$total" ]; then
  if awk -v u="$utilise" -v t="$total" -v s="$seuil_stockage" 'BEGIN { exit !(u * 100 >= s * t) }'; then
    pourcent="$(awk -v u="$utilise" -v t="$total" 'BEGIN { printf "%.1f", u * 100 / t }')"
    alerter stockage_sauvegarde_plein matin "Le stockage de sauvegarde est rempli à ${pourcent} % (seuil : ${seuil_stockage} %)."
  fi
else
  echo "mesure du stockage absente ou absurde (STOCKAGE_UTILISE_OCTETS, STOCKAGE_TOTAL_OCTETS) : le seuil ne peut pas être vérifié" >&2
  erreur=1
fi

# 3. L'effacement : la dernière ligne « ok » du journal d'effacement doit avoir moins de N nuits. Un échec ne remet pas l'horloge à zéro.
dernier_efface=""
base="$(journal_dossier)/console/effacement"
if [ -d "$base" ]; then
  while IFS= read -r fichier; do
    IFS=$'\t' read -r date_ligne _ _ _ resultat _ <"$fichier" || true
    [ "${resultat:-}" = "ok" ] || continue
    if epoch="$(date -u -d "${date_ligne:-}" +%s 2>/dev/null)"; then dernier_efface="$epoch"; break; fi
  done < <(find "$base" -type f -name '*.journal' | sort -r)
fi
limite=$(( nuits * 86400 ))
if [ -n "$dernier_efface" ]; then
  if [ $(( maintenant - dernier_efface )) -gt "$limite" ]; then
    alerter effacement_en_retard matin "L'effacement des vieilles copies n'a pas réussi depuis plus de ${nuits} nuits."
  fi
elif [ "$etat" = "ok" ] && [ "${premiere:--}" != "-" ] && [ $(( maintenant - premiere )) -gt "$limite" ]; then
  # Jamais lancé, alors qu'une sauvegarde de plus de N nuits existe : la tâche aurait déjà dû tourner.
  alerter effacement_en_retard matin "L'effacement des vieilles copies n'a jamais réussi alors que des copies de plus de ${nuits} nuits existent."
fi

exit "$erreur"
