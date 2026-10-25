#!/usr/bin/env bash
# Initialise l'OpenBao du socle (POUR LE TEST) : Shamir 5 parts / seuil 3, montages clients/ (KV v2) et transit/,
# clé de signature des modules, politiques, jetons des rôles api, courtier, equipe, signature, echanges et secours, puis révocation du jeton racine.
#   initialiser.sh <fichier-de-sortie>   le fichier reçoit les parts et les jetons des rôles (droits 600), jamais la sortie standard
# Les parts et les jetons restent dans des variables : masqués avant tout usage, jamais affichés, jamais versionnés.
set -euo pipefail
umask 077
set -o noclobber

dossier="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fichier="${1:?chemin du fichier de sortie absent}"
export BAO_ADDR="http://127.0.0.1:8200"
if [ -e "$fichier" ] || [ -L "$fichier" ]; then echo "fichier de sortie déjà présent : refusé" >&2; exit 1; fi
: >"$fichier"
trap 'unset BAO_TOKEN' EXIT

bao() { docker compose -p socle exec -T -e BAO_ADDR -e BAO_TOKEN openbao bao "$@"; }
masquer() { if [ -n "${GITHUB_ACTIONS:-}" ]; then echo "::add-mask::$1"; fi; }

sortie_init="$(bao operator init -key-shares=5 -key-threshold=3 -format=json)"
mapfile -t parts < <(jq -r '.unseal_keys_b64[]' <<<"$sortie_init")
racine="$(jq -r '.root_token' <<<"$sortie_init")"
unset sortie_init
masquer "$racine"
for part in "${parts[@]}"; do masquer "$part"; printf 'PART=%s\n' "$part" >>"$fichier"; done

for i in 0 1 2; do printf '%s' "${parts[$i]}" | bao operator unseal - >/dev/null; done
unset parts

export BAO_TOKEN="$racine"
unset racine
bao secrets enable -path=clients -version=2 kv >/dev/null
bao secrets enable transit >/dev/null
bao secrets enable -path=technique -version=2 kv >/dev/null
# Clé de signature des modules (A-193) : jamais exportable, pas de copie transit ; le secours (A-303) se fait par instantané raft (ADR 0017).
bao write -f transit/keys/modules-signature type=ed25519 exportable=false >/dev/null
for role in api courtier equipe signature echanges secours; do
  bao policy write "$role" - <"$dossier/politiques/$role.hcl" >/dev/null
  jeton="$(bao token create -policy="$role" -no-default-policy -orphan -period=768h -format=json | jq -r '.auth.client_token')"
  masquer "$jeton"
  printf '%s=%s\n' "$(printf '%s' "$role" | tr '[:lower:]' '[:upper:]')" "$jeton" >>"$fichier"
  unset jeton
done

bao token revoke -self >/dev/null
