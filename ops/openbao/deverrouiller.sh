#!/usr/bin/env bash
# Déverrouille OpenBao après un redémarrage (C-523). Les parts Shamir se lisent sur l'entrée standard, une par ligne :
# jamais en argument, jamais dans l'historique du shell, jamais affichées. Seuil : 3 parts sur 5.
#   deverrouiller.sh            (saisie masquée au clavier, ou parts collées une par ligne)
# Chaque part part à OpenBao en corps JSON sur l'entrée standard de « bao write sys/unseal » (jamais dans ps).
# Variables : BAO_ADDR (adresse du coffre), BAO_COMMANDE (par défaut « bao »).
# Codes de sortie : 0 déverrouillé, 1 encore scellé, 2 coffre injoignable, 64 mauvais usage.
set -euo pipefail
set +x # un « bash -x » afficherait chaque part en clair
umask 077

if [ "$#" -ne 0 ]; then echo "aucun argument : les parts se donnent sur l'entrée standard" >&2; exit 64; fi
bao="${BAO_COMMANDE:-bao}"

# Écrit l'état JSON du coffre ; code 0 ouvert, 2 scellé, autre : injoignable.
etat() {
  local code=0
  ETAT="$("$bao" status -format=json 2>/dev/null)" || code=$?
  { [ "$code" -eq 0 ] || [ "$code" -eq 2 ]; } && jq -e . >/dev/null 2>&1 <<<"$ETAT" || return 1
  return 0
}
champ() { jq -r "(.data // .) | $1" <<<"$2"; }

if ! etat; then echo "coffre injoignable : aucune part consommée, vérifier BAO_ADDR et le réseau" >&2; exit 2; fi

recues=0
refusees=0
while true; do
  if [ "$(champ '.sealed' "$ETAT")" = "false" ]; then echo "déverrouillé"; exit 0; fi
  if [ -t 0 ]; then IFS= read -rs -p "part $((recues + refusees + 1)) : " part || break; echo >&2; else IFS= read -r part || break; fi
  [ -n "$part" ] || continue
  if ! [[ "$part" =~ ^[A-Za-z0-9+/=]+$ ]]; then
    refusees=$((refusees + 1)); echo "part illisible (caractères inattendus), ignorée" >&2; unset part; continue
  fi
  code=0
  reponse="$(printf '{"key":"%s"}' "$part" | "$bao" write -format=json sys/unseal - 2>/dev/null)" || code=$?
  unset part
  if [ "$code" -ne 0 ]; then
    if ! etat; then echo "coffre injoignable pendant l'envoi d'une part" >&2; exit 2; fi
    refusees=$((refusees + 1)); echo "part refusée par le coffre" >&2
    continue
  fi
  recues="$(champ '.progress // 0' "$reponse")"
  [ "$(champ '.sealed' "$reponse")" = "false" ] && { echo "déverrouillé"; exit 0; }
  ETAT="$reponse"
done

seuil="$(champ '.t // 3' "$ETAT")"
echo "encore scellé, ${recues} parts reçues sur ${seuil} (${refusees} refusées)" >&2
exit 1
