# 0110 · Routes de l'exécuteur : exception nommée de la garde des canaux, routes listées pour la garde mauvais client

Date : 05/11/2026 · Statut : proposé (rédigé par la routine de la PR T4-21 2/2 sur consigne de l'orchestrateur ; accord de l'architecte à confirmer à la relecture) · Contrat touché : aucun · Migration : aucune

## Contexte
La garde des canaux (C-510) exige `enregistrerCanal` pour toute route sous `/api/hub/`, `/api/crm/` ou `/api/executeur/`. Or `enregistrerCanal` ne sait servir que le Hub et le CRM (clé `c4:<cellule>:<kid>` non applicable, GET sans corps, pas d'`Idempotency-Key`). Les deux routes de l'exécuteur (`…/configuration`, `…/etat-voulu`) ont leur propre contrôle : signature de requête de la cellule, puis jeton d'instance (fiche T4-21).

## Décision
- `enregistrerCanal` n'est pas étendu.
- `scripts/garde-canaux.ts` porte une exception nommée et minimale : le seul fichier `apps/api/src/routes/executeur/index.ts`. Tout autre fichier sous `/api/executeur/` sans `enregistrerCanal` reste refusé (test dans `garde-canaux.test.ts`, `[C-510]`).
- `scripts/liste-routes.ts` liste bien les deux routes de l'exécuteur, et `tests/mauvais-client/executeur.test.ts` porte leurs essais `[C-536] @isolation` : une instance d'une autre cellule ou d'un autre client répond 404.

## Conséquences
- Les lignes `T4-21-dette-garde-canaux` et `T4-21-dette-liste-routes-c536` de `spec/preuves.md` sont soldées par ce choix.
- Une nouvelle route de l'exécuteur dans un autre fichier échoue à la garde tant qu'elle n'est pas nommée ici par un nouvel ADR.
