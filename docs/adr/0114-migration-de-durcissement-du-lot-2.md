# 0114 · Migration 0019 de durcissement du lot 2

Date : 06/11/2026 · Statut : proposé (PR T2-52a, audits `auditeur-argent` puis `auditeur-securite` à venir ; accord de l'architecte à confirmer) · Contrat touché : C5 (liste `EXCEPTIONS_UNICITE`, une entrée nominative déjà décidée par l'ADR 0111) · Migration : `0019_durcissement_lot_2.sql`

## Contexte
- La fiche T2-52 regroupe les dettes du lot 2 qui demandent une migration. La numérotation réservée (0014) tombait avant 0018, déjà appliquée : drizzle-kit numérote à la suite de l'`idx` du journal, sans tenir compte des réservations.
- L'ADR 0111 a tranché `instances.id` (option A) et l'oracle de la clé étrangère de cellule ; ses points 2, 3 et 4 sont livrés ici.

## Décision
1. **Numéro** : T2-52 prend 0019 et rend 0014. Après `drizzle-kit generate`, le `.sql`, `meta/NNNN_snapshot.json` et le tag du journal sont renommés ensemble en 0019 ; `idx` et `when` ne bougent pas.
2. **Une seule migration, additive** : aucun `DROP`, `DELETE`, `TRUNCATE`, `RENAME` ni changement de type. Un doublon d'`instances.id`, un code de cellule hors forme C4 ou un SIREN à clé fausse déjà en base fait échouer la migration (échec fermé, une seule transaction) : rien n'est modifié.
3. **`instances`** : `id` reçoit `DEFAULT gen_random_uuid()` et un index unique `instances_id_unique` (exception nominative, ADR 0111). `console_app` perd `INSERT`, `UPDATE` et `DELETE` hérités et reçoit des droits par colonne qui excluent `id` et `cellule_code` (et `tenant_id` pour `UPDATE`). Tout futur `ADD COLUMN` sur `instances` ajoute son propre `GRANT` par colonne.
4. **Cellule** : l'attribution passe par `public.attribuer_cellule(uuid, text)` (`SECURITY DEFINER`, `search_path` fixé, révoquée à `PUBLIC`, accordée à `console_equipe`). Même erreur `P0002` que la cellule ou l'instance existe ou non. Le client vient de `app.tenant_id`, l'acteur de `app.acteur` (posés par `avecEquipeEcriture`). Deux politiques étroites sont ajoutées pour le propriétaire (lecture et mise à jour bornées à `app.tenant_id`), plus une lecture des cellules. Aucun `BYPASSRLS`. Si l'audit ou un déclencheur refuse l'appel sous le propriétaire, on s'arrête (ESCALADE), on ne contourne pas.
5. **Contraintes** : forme C4 de `cellules.code` (`cellules_code_forme_c4`, qui s'ajoute à l'ancienne), clé de Luhn du SIREN des apporteurs, bornes de 200 caractères sur `executions.auteur`, `executions.termine_par` et `alertes.assignee_a`, motif de levée de gel (`gels_litige.motif_levee` ; un motif n'existe que sur un gel levé. La levée sans motif n'est pas encore refusée, parce que `leverGel` (T2-52b) n'écrit pas encore le motif : à resserrer quand le code l'écrit, ESCALADE ouverte).
6. **Index** : anti-doublon des `a_trancher` ouvertes (cohérence de nuit, demande du Hub), lignes dues de `boite_envoi`, alertes C3 non confirmées.
7. **Déclencheur** `propositions_statut_final` : un statut final ne change plus. **Table** `reservations_alertes_quota` (par client, RLS forcée, aucun `DELETE`) pour réserver les alertes de quota.
8. **Pas de contrainte IPv4** sur `cellules.adresse_interne` : à valider après un relevé par ops.

## Contrôles en lecture seule avant le déploiement (ops)
À lancer par ops sur la base réelle ; un résultat non vide se traite avant la migration (jamais par `DELETE`) :
- `SELECT id, count(*) FROM instances GROUP BY id HAVING count(*) > 1;`
- `SELECT code FROM cellules WHERE code !~ '^[a-z0-9]+(-[a-z0-9]+)*$' OR char_length(code) > 64;`
- `SELECT tenant_id, donnees_comparaison->>'cle', count(*) FROM a_trancher WHERE etat = 'ouvert' AND motif = 'incoherence_nuit' GROUP BY 1, 2 HAVING count(*) > 1;` (idem pour `idDemande` avec `source = 'hub'`). Les doublons se **tranchent** (`etat = 'tranche'`, décision « doublon »).
- Les SIREN des apporteurs dont la clé de Luhn est fausse, et les textes de plus de 200 caractères des trois colonnes bornées.

## Conséquences
- `EXECUTEUR_API_OUVERTE` reste fermée tant que cette migration n'est pas acceptée par l'`auditeur-argent`.
- Retour arrière à la main seulement (jamais par une migration) : supprimer le déclencheur et les deux fonctions, refaire les `GRANT`. Colonnes, index, contraintes et table restent.
- Les essais d'intégration qui insèrent une instance sous `console_app` relisent l'id par `RETURNING id`.

## Options écartées
- Reprendre 0014 : plus petit qu'une migration déjà appliquée, source de confusion.
- `UPDATE` direct de `cellule_code` par `console_app` : garde l'oracle de la clé étrangère (23503 selon l'existence du code).
