# Preuves · équilibrage des fragments du socle d'intégration

Exigences : A-066, C-538 (aucune exigence nouvelle). Décision : ADR 0121.

| Preuve | Test | Commande |
|---|---|---|
| Chaque fichier d'intégration dans un seul fragment, union complète | `[A-066]` scripts/partition-integration.test.ts | `pnpm test -- partition-integration` |
| Charge estimée équilibrée (fragment le plus long au plus égal au fichier le plus lourd ou à la moyenne + 10 %) | `[A-066]` idem | idem |
| La configuration Vitest donne à chaque fragment sa liste, union = tout ; valeur invalide refusée | `[C-538]` idem | idem |
| Contrôle requis `socle-integration` : `if always`, `needs` tous les fragments, échec si un fragment n'est pas `success` | `[A-066]` scripts/garde-compose.test.ts | `pnpm test -- garde-compose` |
| Liste blanche : fragments sans `--shard`, variable `FRAGMENT_INTEGRATION` seulement | `[C-020]` scripts/garde-licences.test.ts | `pnpm test -- garde-licences` |

Durées avant et après : voir le corps de la PR.
