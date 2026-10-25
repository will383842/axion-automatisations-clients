#!/usr/bin/env bash
# Déverrouille OpenBao après un redémarrage (C-523). Les parts Shamir se lisent sur l'entrée standard, une par ligne :
# jamais en argument, jamais dans l'historique du shell, jamais affichées. Seuil : 3 parts sur 5.
#   deverrouiller.sh            (saisie masquée au clavier, ou parts collées une par ligne)
# Variables : BAO_ADDR (adresse du coffre), BAO_COMMANDE (par défaut « bao »).
set -euo pipefail
umask 077

if [ "$#" -ne 0 ]; then echo "aucun argument : les parts se donnent sur l'entrée standard" >&2; exit 64; fi
bao="${BAO_COMMANDE:-bao}"

etat() { "$bao" status -format=json 2>/dev/null || true; }
compter() { jq -r '"\(.progress // 0) \(.t // 3) \(.sealed)"' <<<"$(etat)"; }

lues=0
while true; do
  scelle="$(compter | cut -d' ' -f3)"
  if [ "$scelle" = "false" ]; then echo "déverrouillé"; exit 0; fi
  if [ -t 0 ]; then IFS= read -rs -p "part $((lues + 1)) : " part || break; echo >&2; else IFS= read -r part || break; fi
  [ -n "$part" ] || continue
  printf '%s' "$part" | "$bao" operator unseal - >/dev/null 2>&1 || true
  unset part
  lues=$((lues + 1))
done

lecture="$(compter)"
if [ "${lecture##* }" = "false" ]; then echo "déverrouillé"; exit 0; fi
seuil="$(cut -d' ' -f2 <<<"$lecture")"
echo "encore scellé, ${lues} parts reçues sur ${seuil}" >&2
exit 1
