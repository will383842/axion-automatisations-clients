# 0029 · Zéro conflit sur les fichiers partagés

Date : 26/10/2026 · Statut : proposé

## Contexte
Les PR parallèles se bloquaient par des conflits sur des fichiers où chacune ajoute une ligne : l'index des ADR (12 modifications en une semaine), `spec/preuves.md`, `ops/secrets-inventaire.md`, `docs/localisation-des-donnees.md`. Les numéros d'ADR se disputaient aussi (0015 a dû être renuméroté, 0013 n'existe pas). Le compteur de tests et les empreintes de contrats ont déjà été réglés par l'ADR 0019.

## Décision
- L'index des ADR est généré (`scripts/adr-index.ts`) à partir des fichiers ; `docs/adr/README.md` ne contient plus de liste. Une garde (dans `pnpm test`) refuse deux ADR de même numéro, un nom qui ne suit pas le titre et un `docs/adr/index.md` écrit mais périmé.
- `.gitattributes` : `merge=union` sur les trois fichiers append-only (`spec/preuves.md`, `ops/secrets-inventaire.md`, `docs/localisation-des-donnees.md`), pas sur les JSON ni sur `pnpm-lock.yaml`. Vérifié par des fusions réelles de deux branches (test).
- Règle de contribution : fusionner `main` dans la branche avant d'ouvrir la PR et avant de demander la relecture.

## Conséquences
- Limite connue : GitHub ignore `merge=union` pour son bouton de fusion et son calcul de conflit. Le pilote ne joue qu'en local, d'où la règle de fusion de `main` avant la PR.
- `merge=union` garde les deux versions d'une même ligne modifiée des deux côtés : à relire si on corrige une ligne existante (cas rare, ces fichiers s'écrivent par ajout).
- Aucun workflow modifié.
