# T6-24c · Routes des préférences de notification, SQL, résumé hebdomadaire (inerte)

Exigences : B-141, B-186.

## Preuves
- `apps/api/src/routes/portail/notifications.test.ts` : la rubrique liste les préférences de l'utilisateur de la session seulement ; PUT sur une ligne non désactivable ou inconnue = 422 sans écriture ; corps mal formé ou champ en trop = 400 ; routes fermées par défaut (503).
- `tests/mauvais-client/notifications.test.ts` : `[C-536] @isolation` GET et PUT ignorent tout client ou utilisateur désigné par l'adresse, un en-tête, un cookie ou le corps.
- `apps/api/src/portail/notifications.test.ts` : lecture filtrée par client ET utilisateur ; écriture avec `ON CONFLICT` et clé minuscule ; résumé sur la ligne réservée.
- `apps/api/src/portail/resume-hebdo.test.ts` : couper le résumé = plus de résumé ; source absente = rubrique omise (jamais 0) ; un `jobId` par utilisateur et par semaine ; sans la ligne dans la vraie table, rien ne part (refus tracé).
- `apps/api/src/db/portail.int.test.ts` : 2 cas ajoutés (acteur et `maj_le`, seconde écriture sur la même ligne ; lecture d'un collègue). Écrits pour le job `socle-integration` : pas de Docker en session, aucun résultat inventé.

## Rouge puis vert
- Rouge : premier commit, tests seuls (modules et fonctions absents).
- Vert : deuxième commit, code minimal.

## Fichiers hors fiche
- `apps/api/src/routes/branchements/portail-notifications.ts` (nouveau) : remplace les « entrées » de `serveur.ts` et `scripts/liste-routes.ts` prévues par le plan, depuis l'ADR 0139 (une route s'inscrit par un fichier neuf de `routes/branchements/`). `serveur.ts` et `liste-routes.ts` ne sont pas touchés.

## Ce qui reste
- ESCALADE : `apps/api/src/portail/roles.ts` n'a pas de rubrique `notifications` et n'est pas dans les fichiers autorisés. La garde du portail refuse donc (403) ces routes à tous tant que la règle manque : fermé, sans danger. Règle proposée : `notifications: regle(TOUS, TOUS)` (préférences de l'utilisateur lui-même). Critère : `[C-501] la rubrique notifications a sa règle dans roles.ts`.
- Rien n'est branché dans `serveur.ts` : les routes n'existent que si l'appelant fournit `notificationsPortail`.
