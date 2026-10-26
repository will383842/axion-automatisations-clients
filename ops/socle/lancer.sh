#!/usr/bin/env bash
# Lance le socle en conteneurs jetables : compose.base.yml puis chaque fragment compose.*.yml, par ordre alphabétique.
#   lancer.sh              démarre et attend la santé (docker compose up -d --wait)
#   lancer.sh --assembler  imprime le compose assemblé (docker compose config), sans rien démarrer
#   lancer.sh --arreter    arrête et supprime conteneurs et volumes
# Le fragment compose.zz-essai-*.yml n'est lu que sur la CI (GITHUB_ACTIONS) ou avec SOCLE_ESSAI=1.
set -euo pipefail

dossier="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mode="${1:-demarrer}"

fichiers=(-f "$dossier/compose.base.yml")
for f in "$dossier"/compose.*.yml; do
  nom="$(basename "$f")"
  [ "$nom" = "compose.base.yml" ] && continue
  case "$nom" in
    compose.zz-essai-*.yml) [ -n "${GITHUB_ACTIONS:-}" ] || [ -n "${SOCLE_ESSAI:-}" ] || continue ;;
  esac
  fichiers+=(-f "$f")
done

# Mots de passe de test : générés ici, exportés dans l'environnement du processus, jamais écrits dans un fichier versionné.
MOTS_DE_PASSE=(SOCLE_PG_MOT_DE_PASSE SOCLE_VALKEY_MOT_DE_PASSE SOCLE_KEYCLOAK_ADMIN_MOT_DE_PASSE SOCLE_KEYCLOAK_SECRET_CONSOLE SOCLE_KEYCLOAK_SECRET_PORTAIL SOCLE_STOCKAGE_MOT_DE_PASSE SOCLE_LITELLM_CLE_MAITRE)

case "$mode" in
  --assembler | --arreter)
    # Valeurs sans effet : le compose se lit et s'arrête sans générer de certificat ni de mot de passe.
    export SOCLE_CERTS="${SOCLE_CERTS:-/nonexistent}"
    for v in "${MOTS_DE_PASSE[@]}"; do export "$v=${!v:-valeur-sans-effet}"; done
    export SOCLE_KEYCLOAK_BD_MOT_DE_PASSE="${SOCLE_KEYCLOAK_BD_MOT_DE_PASSE:-valeur-sans-effet}"
    if [ "$mode" = "--assembler" ]; then
      exec docker compose -p socle "${fichiers[@]}" config
    fi
    exec docker compose -p socle "${fichiers[@]}" down -v --remove-orphans
    ;;
esac

certs="$(mktemp -d)"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=socle.test" \
  -addext "subjectAltName=DNS:*.socle.test" \
  -keyout "$certs/socle.key" -out "$certs/socle.crt" 2>/dev/null
chmod 755 "$certs"
chmod 644 "$certs/socle.key" "$certs/socle.crt"
export SOCLE_CERTS="$certs"

for v in "${MOTS_DE_PASSE[@]}"; do
  if [ -z "${!v:-}" ]; then
    valeur="$(openssl rand -hex 24)"
    if [ -n "${GITHUB_ACTIONS:-}" ]; then echo "::add-mask::$valeur"; fi
    export "$v=$valeur"
  fi
done

# Mot de passe du rôle keycloak_app : même calcul que ops/socle/postgres/init/05-keycloak.sql (SHA-256 de « secret/rôle »).
SOCLE_KEYCLOAK_BD_MOT_DE_PASSE="$(printf %s/keycloak_app "$SOCLE_PG_MOT_DE_PASSE" | sha256sum | cut -c1-64)"
if [ -n "${GITHUB_ACTIONS:-}" ]; then echo "::add-mask::$SOCLE_KEYCLOAK_BD_MOT_DE_PASSE"; fi
export SOCLE_KEYCLOAK_BD_MOT_DE_PASSE

exec docker compose -p socle "${fichiers[@]}" up -d --wait
