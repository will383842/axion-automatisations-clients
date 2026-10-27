#!/usr/bin/env bash
# Sauvegarde complète de nuit de la grappe commune (A-190), chiffrée avant de quitter le serveur (C-046, C-593).
# S'exécute dans le conteneur PostgreSQL. « check » avant la première sauvegarde : sans lui, l'archivage échoue sans bruit.
# Rétention (C-049) : le premier dépôt garde 30 complètes, le second une complète par mois (12 gardées).
set -euo pipefail

phrase="$(/opt/sauvegardes/lire-phrase-chiffrement.sh)"
PGBACKREST_REPO1_CIPHER_PASS="$phrase"
PGBACKREST_REPO2_CIPHER_PASS="$phrase"
export PGBACKREST_REPO1_CIPHER_PASS PGBACKREST_REPO2_CIPHER_PASS

pgbackrest --stanza=commun stanza-create
pgbackrest --stanza=commun check
pgbackrest --stanza=commun --type=full backup

# Une complète dans le second dépôt quand le mois n'en a pas encore (étiquette AAAAMMJJ-HHMMSSF).
mois="$(date -u +%Y%m)"
deja="$(pgbackrest --stanza=commun --repo=2 --output=json info | grep -c "\"label\":\"${mois}" || true)"
if [ "$deja" -eq 0 ]; then
  pgbackrest --stanza=commun --repo=2 --type=full backup
fi

# Sur la vraie Storage Box en ajout seul (lot 1-B), « expire » échouera : voir le README.
pgbackrest --stanza=commun expire
