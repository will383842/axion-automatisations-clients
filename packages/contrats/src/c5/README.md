# C5 · Schéma des bases (version 0, sans migration)

`invariants.ts` contient les contrôles du schéma, prêts à tourner : aucune table n'est créée ici.
Le propriétaire unique des migrations est la 1re tâche du lot 2.

## Bases
- `console` : métadonnées.
- `moteur` : état technique (purge 24 h / 7 jours).
- `cli_<id>` : données de travail, une base par client.

## Tables de la version 0 (noms seulement, aucune colonne figée)
organisations, contacts, abonnements, instances, configurations, connexions (référence au coffre seulement), exécutions (partitionnées par mois), alertes, demandes (métadonnées), notes, factures (lien Hub), plans commerciaux, phases, échéances, boîte d'envoi, faits reçus, journal d'audit, bases client, lien CRM, visibilité et accès.

## Contrôlé par `invariants.ts`
- Table métier (tous les schémas, partitions comprises ; seule exemption : la table de migrations `__migrations`) : `tenant_id` NOT NULL, politique RLS, `FORCE ROW LEVEL SECURITY`, index dont la 1re colonne de la clé est `tenant_id`.
- Chaque politique permissive retient les lignes par `tenant_id` (USING et WITH CHECK, lus dans `pg_policies`) : `USING (true)` est signalé. Contrôle de présence du mot, non une preuve : la revue reste nécessaire.
- Les partitions ont leur propre RLS, FORCE et politique : PostgreSQL n'applique pas celles du parent à une lecture directe.
- Le rôle de l'application ne possède aucune table, et n'est ni superutilisateur ni BYPASSRLS.
- Une base `cli_%` n'est pas ouverte à `PUBLIC` (droit CONNECT).
- Journal d'audit : déclencheurs actifs (origine ou toujours, pas « réplique ») qui refusent UPDATE, DELETE et TRUNCATE (ajout seul).
- Argent en entiers (`%_centimes`), jamais en `numeric`, `real` ou `double`.
- Vocabulaire en énumération, pas en `text`.

## À brancher au lot 2
- Chaînage par hachage du journal d'audit.
- Unicités (facture d'abonnement, bon de commande, clé d'idempotence, `event_id`).
- Texte des demandes dans `cli_<id>` seulement.
- Règle N / N-1 des migrations, montante et descendante.

## Lancer les tests
Ils demandent un PostgreSQL jetable : `CONTRATS_PG_URL=postgresql://… pnpm test -- c5`. Sans cette variable, ils sont sautés (le job de CI `contrats-pg` reste à écrire : lot 2 / T0-30).
