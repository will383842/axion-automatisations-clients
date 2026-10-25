# Migrations de la base

- Seules des migrations **versionnées** touchent la base : elles sont générées par `drizzle-kit` (`pnpm exec drizzle-kit generate`, dans `apps/api`) et relues avant fusion.
- Elles sont appliquées par le déploiement avec `apps/api/src/db/migrer.ts`, sous le rôle `console_migration` (jamais `console_app`), après un essai sur la recette. **Jamais à la main en production.**
- Elles sont **additives** : la version N et la version N-1 de l'application doivent tourner sur le même schéma. On ajoute, on ne supprime pas, on ne renomme pas, on ne change pas un type, on ne vide pas une table.
- La garde `scripts/garde-migrations.ts` (contrôle `garde-migrations`) lit tous les `apps/*/drizzle/**/*.sql` et échoue sur `DROP`, `RENAME`, `ALTER … TYPE`, `TRUNCATE` et le SQL dynamique (`EXECUTE`). Elle attrape aussi le `DROP` que `drizzle-kit` écrit parfois pour un renommage.
- Une exception passe par un ADR (`docs/adr/`) et l'accord de l'architecte.
- Le journal des migrations appliquées est la table `drizzle.__drizzle_migrations`.
