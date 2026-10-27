#!/usr/bin/env bash
# Sauvegarde complète de nuit de la grappe commune (A-190), chiffrée avant de quitter le serveur (C-046, C-593).
# S'exécute dans le conteneur PostgreSQL. « check » avant la première sauvegarde : sans lui, l'archivage échoue sans bruit.
# La phrase est relue À CHAQUE sauvegarde (rotation prise en compte, échec visible si OpenBao est injoignable) et AVANT toute commande pgBackRest (A-196).
# L'expiration n'est PAS faite ici : expirer.sh (sur l'hôte) la pilote avec retention.ts, après cette sauvegarde (C-049).
set -euo pipefail

PGBACKREST_REPO1_CIPHER_PASS="$(/opt/sauvegardes/lire-phrase-chiffrement.sh)"
export PGBACKREST_REPO1_CIPHER_PASS

pgbackrest --stanza=commun stanza-create
pgbackrest --stanza=commun check
pgbackrest --stanza=commun --type=full backup
