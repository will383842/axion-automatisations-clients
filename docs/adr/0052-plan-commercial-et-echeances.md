# 0052 · Plan commercial, phases, échéances et conditions du client

Date : 01/11/2026 · Statut : proposé (T2-04, maillon 5 de la chaîne des migrations) · Contrat touché : aucun (C5 inchangé) · Fiche d'argent : **solution la plus restrictive retenue partout**

## Contexte
T2-04 pose, en une migration (`0008_commercial.sql`, qui suppose `0007` de T2-03 déjà appliquée), les tables qui disent ce que paie chaque automatisation et quand : `abonnements`, `plans_commerciaux`, `phases_plan`, `echeances`, `conditions_commerciales`. Le calcul des valeurs (héritage) reste en T2-08.

## Décision
1. **Unicités par client** (ADR 0040) : `plans_commerciaux (tenant_id, instance_id)`, `phases_plan (tenant_id, plan_id, ordre)`, `echeances (tenant_id, plan_id, debut_periode)`. Aucune unicité sans `tenant_id` ; `EXCEPTIONS_UNICITE` reste vide. Un doublon chez le même client donne `23505` sur sa propre ligne ; la même période chez deux clients est permise. Les clés étrangères entre ces tables sont composées `(tenant_id, x)` vers `UNIQUE (tenant_id, id)`.
2. **Argent** : `bigint` en centimes, jamais `numeric`. Le schéma Drizzle lit en `number` (`mode: 'number'`) ; un `CHECK ... BETWEEN 0 AND 9007199254740991` (2^53 − 1) interdit toute valeur que `number` ne représenterait pas exactement, donc pas de `bigint` JavaScript à manipuler. Taux en points de base (`integer`, de 0 à 10000). Valeur négative, à virgule ou hors borne : refusée par la base.
3. **Formule V1** : `plans_commerciaux.formule` est l'énumération `formule_instance` ; un `CHECK` (`plans_commerciaux_formule_v1`) ne permet que `abonnement`. Les formules `achat` et `installation_maintenance` demandent un ADR qui lève le `CHECK` en V2. La formule est portée par l'instance (A-006), jamais par l'organisation ni par l'abonnement.
4. **Source de chaque valeur** : une colonne `source_<valeur>` `NOT NULL` (`grille|defaut|client|instance`) pour chacune des huit valeurs du plan. Pas de valeur sans source.
5. **Conditions du client** : `conditions_commerciales` a la source `client` seule (`CHECK`), l'organisation obligatoire, un **auteur non vide** et des dates de validité ordonnées. Les valeurs par défaut d'AXION restent dans `conditions_par_defaut` (T2-02), que cette migration ne touche pas : `console_app` n'y a que la lecture.
6. **Droits restrictifs, ajout seul** : aucun `DELETE`, aucun `TRUNCATE`, aucun droit pour le portail. `console_app` n'a qu'un `UPDATE` par colonnes : échéance (statut, dates d'émission et de paiement, facture) sans jamais le montant, la période ni le plan ; abonnement (`fin`) ; phase (`fin`, `id_plan_hub`) ; condition (`valide_au`). Un plan est immuable : un changement s'écrira par une règle de correction décidée en T2-08, pas par `UPDATE`. Une échéance `payee` exige une date de paiement (`CHECK`).
7. **Audit** : les cinq tables gardent le déclencheur `audit_ecrire` (argent : tout changement est tracé).
8. **Instance → plan** : `instances.plan_commercial` (nullable, additif), clé étrangère composée vers `plans_commerciaux`. La colonne est écrite à la main dans la migration (la table `instances` est dans `clients.ts`, hors des fichiers autorisés de la fiche) : le prochain `drizzle-kit generate` ne la connaît donc pas. **À reprendre** : T2-05 ou la fiche suivante qui touche `clients.ts` doit déclarer la colonne dans le schéma.
9. **Vocabulaires provisoires** : `source_valeur`, `mode_avance`, `suite_maintenance`, `nature_ligne_plan`, `statut_echeance` ; ajouter une valeur est additif. Les énumérations `type_condition` et `source_condition` viennent de T2-02 (ADR 0050).
10. **Numéros** : ADR 0052 et migration `console` 0008, réservés. Le snapshot `0008` suppose `0007` : à fusionner avec `main` après T2-03 (journal et `prevId`).

## Conséquences
- Essais : `apps/api/src/db/schema/commercial.test.ts` (migration relue) et `apps/api/src/db/commercial.int.test.ts` (job `socle-integration`).
- Écart avec la fiche : le paragraphe sur `bigint` demandé pour « l'ADR 0010 » est ici (0010 n'est pas un fichier autorisé). `spec/compte-tests*.json` n'existent pas (compteur mesuré par la CI, ADR 0019).
- Dette connue, hors fichiers de la fiche : `conditions_par_defaut` (T2-02) n'a ni auteur `NOT NULL` ni journal d'audit ; à traiter par une fiche qui a `canaux.ts` dans ses fichiers.
- Aucune migration ne supprime ni ne renomme quoi que ce soit (N / N-1 respecté).
