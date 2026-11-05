# 0029 · Zéro conflit sur les fichiers partagés

Date : 26/10/2026 · Statut : proposé

## Contexte
Les PR parallèles se bloquaient par des conflits sur des fichiers où chacune ajoute une ligne : l'index des ADR (12 modifications en une semaine), `spec/preuves.md`, `ops/secrets-inventaire.md`, `docs/localisation-des-donnees.md`. Seul `spec/preuves.md` s'écrit par ajout ; les deux autres sont des tableaux modifiés sur place (rotation, lieu). Les numéros d'ADR se disputaient aussi (0015 a dû être renuméroté, 0013 n'existe pas). Le compteur de tests et les empreintes de contrats ont déjà été réglés par l'ADR 0019.

## Décision
- L'index des ADR est généré (`scripts/adr-index.ts`) à partir des fichiers ; `docs/adr/README.md` ne contient plus de liste. Une garde (dans `pnpm test`) refuse deux ADR de même numéro, un nom qui ne suit pas le titre et un `docs/adr/index.md` écrit mais périmé.
- `.gitattributes` : `merge=union` sur le seul fichier réellement ajouté ligne à ligne, `spec/preuves.md`. Pas sur `ops/secrets-inventaire.md` ni `docs/localisation-des-donnees.md` (modifiés sur place : l'union y garderait en silence deux versions contradictoires), ni sur les JSON, ni sur `pnpm-lock.yaml`. Vérifié par des fusions réelles de deux branches (test).
- `scripts/couverture-req.ts` refuse un numéro présent deux fois dans `spec/preuves.md` (cas que l'union laisse passer : même numéro, textes différents).
- `scripts/adr-index.ts` signale tout fichier de `docs/adr/` (hors `README.md` et `index.md`) dont le nom ne suit pas `NNNN-sujet.md`.
- Règle de contribution : fusionner `main` dans la branche avant d'ouvrir la PR et avant de demander la relecture.

## Conséquences
- Limite connue : GitHub ignore `merge=union` pour son bouton de fusion et son calcul de conflit. Le pilote ne joue qu'en local, d'où la règle de fusion de `main` avant la PR.
- `merge=union` garde les deux versions d'une même ligne modifiée des deux côtés : à relire si on corrige une ligne existante de `spec/preuves.md` (cas rare, le fichier s'écrit par ajout).
- Limite : deux PR ouvertes en parallèle qui prennent le même numéro d'ADR (deux noms de fichier différents) sont toutes deux vertes ; GitHub les fusionne l'une après l'autre sans conflit et la garde ne devient rouge que sur `main`, après coup. Même limite pour `spec/preuves.md` : deux PR qui ajoutent le même numéro en des endroits éloignés fusionnent sans conflit ; le test `[zero-conflit]` qui lit le vrai fichier tourne dans `pnpm test`, donc dans `ci.yml` sur `push: main`, et rend `main` rouge tout de suite.
- Proposition à Will : activer sur `main` la protection « Require branches to be up to date before merging » (ou une file de fusion), seule façon de faire jouer la garde avant la fusion. Décision de Will, rien n'est changé ici.
- Aucun workflow modifié.

## Mise à jour du 05/11/2026 : un fichier de preuves par fiche
Constat : `merge=union` ne joue pas pour GitHub. Après chaque fusion, toutes les PR ouvertes qui ajoutaient une ligne en fin de `spec/preuves.md` passaient en conflit (une session « fusion de main » et une nouvelle CI de 15 à 25 minutes chacune).

Décision :
- Toute nouvelle ligne de preuve ou de dette va dans un fichier NEUF `spec/preuves/<branche-assainie>.md` (minuscules, tout autre caractère que `a-z0-9` devient un tiret : `lot-0/preuves-par-fiche` → `spec/preuves/lot-0-preuves-par-fiche.md`). Une PR n'ajoute que son fichier ; elle n'édite ni celui d'une autre PR ni `spec/preuves.md`.
- `spec/preuves.md` reste tel quel : historique, en lecture seule par convention. Il n'est pas déplacé, pour ne pas mettre en conflit les PR déjà ouvertes (qui peuvent encore y ajouter leur ligne jusqu'à leur fusion).
- Les lecteurs passent par l'agrégat `scripts/agreger-preuves.ts` : historique d'abord, puis les fichiers de `spec/preuves/` dans l'ordre des noms (le `README.md` du dossier exclu). `couverture-req` et les tests qui lisent une dette l'utilisent ; une garde (test `[ADR-preuves]`) refuse un code qui lit encore `spec/preuves.md` directement et un nom de fichier non assaini.
- Compléter une preuve déjà écrite : ligne `<numéro> (suite) → …` dans son propre fichier. Une seconde ligne `<numéro> → …` reste un doublon, refusé par `couverture-req` sur l'agrégat.
- Vérifié par `git merge-tree` sur deux branches factices : deux fichiers neufs ne se conflictent pas ; l'ajout en fin de fichier, sans pilote local, se conflicte (témoin).

Conséquences : `merge=union` reste pour l'historique tant que des PR anciennes y écrivent. Limite : deux branches de même nom assaini écriraient le même fichier (cas exclu par la règle une fiche = une branche). La garde de lecture directe est un motif, non exhaustif (chemin construit en morceaux).
