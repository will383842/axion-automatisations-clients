# 0010 · `sharp` exclu des applications Next.js

Date : 24/10/2026 · Statut : accepté

## Contexte
Next.js tire `sharp` en dépendance facultative. `sharp` apporte une bibliothèque d'images sous licence LGPL, refusée par la garde des licences pour une dépendance de production.

## Décision
`sharp` est ignoré (`ignoredOptionalDependencies` dans `pnpm-workspace.yaml`). Les squelettes n'utilisent pas l'optimisation d'images de Next.js. Si un écran en a besoin, un nouvel ADR tranchera la licence.

## Conséquences
- Aucune exception de licence n'est ajoutée.
- `next/image` n'est pas à utiliser tant que cet ADR n'est pas remplacé.
