# 0040 · Isolation C5 : unicité et clés étrangères par client

Date : 27/10/2026 · Statut : accepté (ouverture du lot 2, sous-tâche A) · Contrat touché : C5 passe de 0.3.0 à 0.4.0 (reste en 0.x, ADR 0031)

## Contexte
L'essai d'isolation en boîte noire de la porte T1A-19 (A-163) a prouvé un défaut : une contrainte `UNIQUE` sans `tenant_id` sur une table à `tenant_id` fait de l'erreur `23505` un oracle d'existence entre clients. Le client A ne voit pas la ligne du client B (RLS), mais l'insertion échoue ou réussit selon qu'elle existe. Une clé étrangère simple vers une ligne d'un autre client est le même défaut (`23503`) et rattache en plus deux clients. Aucune règle C5 ne les signalait, et le lot 2 pose ses premières tables.

## Décision
- Règle `unicite_sans_tenant` : pour toute table qui a une colonne `tenant_id`, tout index unique (clé primaire, `UNIQUE`, `EXCLUDE`, index partiel, index sur expression) porte `tenant_id` dans sa clé, à n'importe quelle position.
- Seule exemption : la clé primaire d'une seule colonne en identité `GENERATED ALWAYS`, que l'appelant ne peut pas fournir. Un `uuid` par défaut ou une identité `BY DEFAULT` peuvent être fournis par l'appelant : ils sont signalés.
- Règle `etrangere_sans_tenant` : une clé étrangère entre deux tables qui ont `tenant_id` lie `tenant_id` à `tenant_id`, à la même position.
- `EXCEPTIONS_UNICITE` : liste fermée, vide et figée. Une entrée ne s'ajoute qu'avec sa raison, par une PR relue en 2 tours ; aucune option d'appel ne l'étend.
- `TENANT_FACULTATIF` : liste fermée, `public.journal_audit` seulement (les lignes d'équipe du journal d'audit n'ont pas de client). La colonne doit exister ; RLS, `FORCE` et index restent exigés.
- Les deux noms de règles s'ajoutent à la fin de `REGLES_C5`. `INVARIANTS_C5` ne change pas.
- Une unicité voulue entre clients passe par une table sans `tenant_id` ou par une dérivation depuis `tenant_id` (contrainte `CHECK`).

## Conséquences
- Les tâches du lot 2 qui posent des unicités (catalogue, commercial, contrats, exploitation, bases client) préfixent chaque unicité par `tenant_id`.
- Les clés étrangères entre tables métier sont composées : `(tenant_id, x)` vers `UNIQUE (tenant_id, id)`.
- Le test « zéro écart » de chaque migration du lot 2 rougit de lui-même si une unicité ou une clé étrangère oublie `tenant_id`.
- C5 est en 0.x : le rétrécissement (un schéma qui passait peut être signalé) est permis. Les fixtures de C5 et ses empreintes sont régénérées ; les contrats gelés ne bougent pas.
- Preuves : tests unitaires `packages/contrats/src/c5/unicite.test.ts`, essais sur un vrai PostgreSQL `apps/api/src/db/unicite.int.test.ts` et l'essai d'audit A-163 (`tests/audit-1a/postgres.int.test.ts`).
