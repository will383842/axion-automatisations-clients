# 0041 · Fonctions permises dans les migrations

Date : 27/10/2026 · Statut : accepté (ouverture C du lot 2, relecture en 2 tours par l'auditeur de sécurité)

## Contexte
La garde des migrations (A-233, `scripts/garde-migrations.ts`) refuse `CREATE FUNCTION`, `DO`, `SET` et `set_config` : l'analyseur de PostgreSQL ne voit pas dans le corps d'une fonction, donc un `DROP` ou un `set_config` pouvait s'y cacher. Son en-tête parlait d'« exception par ADR » sans qu'aucun mécanisme n'existe.

Or la chaîne de tables du lot 2 (T2-01 : journal d'audit chaîné, déclencheurs, droits) a besoin de fonctions `SECURITY DEFINER`. Deux autres défauts bloquaient la même chaîne :
- `migrer()` laissait drizzle ranger son journal dans `drizzle.__drizzle_migrations`. Les invariants C5 n'exemptent que `public.__migrations` (`TABLE_MIGRATIONS`) : le contrôle « zéro écart » aurait été rouge.
- Drizzle compare les migrations par date (`when`) : une migration générée sur une branche périmée, dont la date est plus ancienne que la dernière appliquée, est sautée sans erreur. Deux `migrer()` simultanés (deux conteneurs au démarrage) se disputaient aussi le journal.

## Décision
1. **Liste fermée de fonctions** : `scripts/garde-migrations-fonctions.json` (`{ "fonctions": [] }` au départ). Une entrée = `fichier` (nom de base du `.sql`), `nom` de la fonction, `empreinte` SHA-256 du texte de l'instruction, `adr`. Le texte va de `stmt_location` sur `stmt_len` (positions en octets), fins de ligne ramenées à LF, espaces des bords retirés ; un commentaire collé devant l'instruction en fait partie. Une entrée lève les étiquettes `CREATE FUNCTION` et `SET` de CETTE instruction seulement.
2. **Toujours refusés**, listés ou non : `CREATE PROCEDURE`, `DO`, `CALL`, `EXECUTE`, `set_config` et tout `SET` hors d'une fonction listée, ainsi que `SECURITY DEFINER` sans `SET search_path = …` (`VAR_SET_VALUE`, pas `FROM CURRENT`) même si la fonction est listée. Tout autre nœud interdit dans l'instruction listée (par exemple un `DROP` dans un corps `BEGIN ATOMIC`) reste refusé.
3. **Une exception ne s'ajoute qu'en relecture à 2 tours** (zone sécurité). Modifier le texte d'une fonction exige une nouvelle migration `CREATE OR REPLACE`, donc une nouvelle entrée ; recalculer à la main une empreinte pour faire passer un texte changé est visible à la relecture. `node scripts/garde-migrations.ts --empreintes <fichier.sql>` affiche `nom empreinte` pour chaque fonction du fichier.
4. **Exceptions mortes** : `gardeMigrations` signale toute entrée sans instruction correspondante.
5. **Dates `when`** : la garde (CI et `migrer()`) refuse un journal dont les `when` ne croissent pas strictement.
6. **`migrer()`** : le journal est `public.__migrations`, avant toute migration réelle (le déplacer plus tard ferait rejouer les migrations). Un verrou consultatif de session (`pg_advisory_lock`) entoure `migrate`. Il suppose une connexion DIRECTE à PostgreSQL, jamais PgBouncer en mode transaction. L'option `journal` est réservée aux essais (noms `^[a-z0-9_]+$`).

## Conséquences
- T2-01a pourra ajouter ses fonctions : écrire le SQL, calculer les empreintes avec `--empreintes`, ajouter les lignes (`adr` : numéro de son ADR), 2 tours d'audit.
- `apps/api/drizzle/` reste vide dans cette PR ; la liste réelle aussi.
- Les essais d'intégration de `migrer` utilisent un journal dans un schéma jetable, sauf l'essai qui prouve `public.__migrations` (il retire sa propre ligne).
- La garde n'est pas un contrôle exigé sur `main` : le chef d'orchestre la vérifie avant chaque fusion.
- Aucun workflow modifié.
