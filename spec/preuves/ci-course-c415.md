# Preuves · course sur le test C-415 du moteur

Exigences : C-415 (aucune exigence nouvelle). Décision : ADR 0121.

| Preuve | Test | Commande |
|---|---|---|
| moteur_purge n'a CONNECT que sur moteur, hors bases jetables `essai_*` des essais de migration | `[C-415]` apps/executeur/src/db/moteur.int.test.ts | `pnpm test -- C-415` |
