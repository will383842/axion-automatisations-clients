# 0138 · Types et lint en un job, compteur de tests dans le job tests

Date : 07/11/2026 · Statut : accepté (accord de l'architecte, 08/11/2026) · Contrat touché : aucun · Migration : aucune · S'appuie sur : 0137

## Décision
1. Les jobs `types` et `lint` de `ci.yml` deviennent un seul job `types-lint` ; le lint a `if: always()`.
2. Le job `compter-tests` disparaît : `tests` lance la suite une seule fois (`pnpm test:compter`, reporters `default` et `json`), puis `scripts/compter-tests.ts` (checkout `fetch-depth: 2`). `tests` reste exigé par `main` et échoue toujours si un test échoue.
3. La liste blanche de `garde-licences` reçoit la nouvelle commande vitest (script `test:compter`).

## Conséquences
- Deux jobs de moins, une installation de moins ; aucune garde retirée.
