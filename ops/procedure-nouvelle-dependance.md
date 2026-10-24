# Procédure : ajouter une nouvelle dépendance (A-377)

À suivre AVANT d'ajouter une bibliothèque (paquet npm, image ou autre brique).

1. **Licence permise.** Livré chez un client : MIT, BSD-2-Clause, BSD-3-Clause, ISC, Apache-2.0, PostgreSQL seulement. MPL-2.0 : seulement dans ce qui n'est jamais livré (`apps/api`, `apps/console`, `apps/portail`, `ops/`). Détail : ADR 0010.
2. **Analyse ScanCode** de la bibliothèque et de ses dépendances (à la main, ou par le job manuel). Garder la sortie : elle montre les licences vues dans les fichiers, pas seulement celles déclarées.
3. **Relecture indépendante** par `relecteur` (un autre agent que celui qui ajoute). Il confirme la licence lue sur le projet, pas sur la fiche du paquet.
4. **Une ligne dans la PR** : `Dépendance : <nom> <version> — <licence SPDX> — ScanCode fait — relue par relecteur`.
5. Pour une **brique serveur ou une image** : ajouter `ops/briques/<brique>.json` (version exacte, empreinte `sha256:`, licence, `livree`, `lieu`, `source`, `verifie_le`). `garde-briques` refuse l'image sinon.
6. **Interdits** : `redis` (Valkey seulement), `bullmq-pro`, toute version « latest », toute fonction sous licence commerciale d'un projet à cœur libre (LiteLLM : aucune fonction `enterprise/`).
7. `pnpm install --frozen-lockfile` partout ; seul l'ajout lui-même modifie `pnpm-lock.yaml`.
