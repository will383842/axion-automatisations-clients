# ADR 0009 — Licences du livre et inventaire des briques

Numéro 0009 : 0007 et 0008 sont déjà pris (la fiche T1A-02 prévoyait 0007).

## Contexte
Il faut savoir à tout moment quelle brique tourne, en quelle version exacte, sous quelle licence, si elle est livrée chez un client, et où sont ses données (A-375, A-381).

## Décision
- **Livré chez un client** (`apps/executeur`, `packages/sdk-module`, `packages/connecteurs-*`, modules, et l'image en V2) : MIT, BSD-2-Clause, BSD-3-Clause, ISC, Apache-2.0, PostgreSQL seulement.
- **MPL-2.0** : seulement dans ce qui n'est JAMAIS livré (`apps/api`, `apps/console`, `apps/portail`, `ops/`). Cela RESTREINT la règle de T0-08, qui la permettait dans `apps/executeur`.
- **AGPL, SSPL, GPL, BUSL, « fair-code »** : jamais livrés. Une brique serveur sous l'une d'elles n'est admise que si elle est inscrite `livree: false` ET nommée dans la liste fermée : `stockage-objet` (si MinIO est retenu, T1A-11), `openbao` (MPL-2.0), `litellm` (MIT pour le cœur, aucune fonction `enterprise/`).
- Un fichier par brique dans `ops/briques/<brique>.json`. `scripts/garde-briques.ts` refuse : image sans fichier ou à empreinte différente, version sans empreinte, `latest`, image `redis` (Valkey seulement), `bullmq-pro` dans `pnpm-lock.yaml`.
- Les fichiers sont lus par de vrais analyseurs (JSON, YAML), jamais par expression régulière. Dépendance ajoutée pour cela : `js-yaml` (MIT), déjà présent dans le verrou comme dépendance indirecte.

## Conséquences
Toute nouvelle brique demande son fichier (procédure : `ops/procedure-nouvelle-dependance.md`). Les images d'`ops/compose.test.yml` sans empreinte sont acceptées tant que la brique porte la sienne ; l'épinglage dans le compose reste à faire par T0-12.

2026-10-24
