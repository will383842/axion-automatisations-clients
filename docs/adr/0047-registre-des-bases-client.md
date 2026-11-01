# 0047 · Registre des bases des clients : tables, droits, deux fonctions de déclencheur

Date : 01/11/2026 · Statut : proposé (T2-30, maillon 2 de la chaîne des migrations) · Contrat touché : aucun

## Contexte
T2-30 pose en une migration (`0005_bases_client.sql`) les onze tables du lot 2b dans la base `console` : bases des clients, versions de structure, fins de contrat, gels, demandes et décisions d'effacement, propositions de suppression, réglages par client, attestations, visibilité.

## Décision
1. **Nom de base dérivé** : `CHECK (nom_base = 'cli_' || replace(tenant_id::text, '-', ''))` et `UNIQUE (tenant_id, nom_base)`. Aucun index unique sur `nom_base` seul (ADR 0040).
2. **Ajout seul par les droits** : `versions_structure`, `confirmations_mise_a_l_ecart`, `decisions_effacement`, `reglages_fin_de_contrat` et `attestations_fin_de_contrat` n'ont ni `UPDATE` ni `DELETE` pour `console_app`. `gels_litige` n'accorde que `UPDATE (levee_le, leve_par)`. Aucune table n'accorde `DELETE`.
3. **Deux fonctions de déclencheur**, ajoutées à `scripts/garde-migrations-fonctions.json` (ADR 0041) : `propositions_transition` (seules les quatre transitions de la fiche passent ; l'identité, la fin de contrat et l'échéance ne changent pas) et `decisions_controle_gel` (le gel d'une décision pour litige existe chez ce client et est actif à la date de la décision). Une contrainte `CHECK` ne voit ni l'ancienne ligne ni une autre table : sans fonction, ces deux règles ne seraient pas tenues par la base. Ce fichier de garde n'est pas dans les fichiers autorisés de la fiche ; la liste fermée l'exige (même cas que l'ADR 0044, point 12). **À relire en 2 tours (zone sécurité).**
4. **Rôles absents** : `portail_app` et `equipe-export` n'existent pas dans la base `console` du socle. La migration ne leur accorde rien (elle échouerait sur un rôle inconnu) : `PUBLIC` est fermé et seuls `console_app` (lecture, ajout, changements d'état prévus) et `console_equipe` (lecture) ont des droits. L'absence de droit du portail est prouvée par les droits réels de chaque table. Si `equipe-export` doit exister, son rôle et son `GRANT SELECT` viennent avec la fiche qui crée le rôle.
5. **Préavis** : six colonnes (date d'envoi et preuve d'accusé de J+1, J+20, J+27) dans `fins_de_contrat`, car « aucune table hors de la liste » de la fiche. **Valeurs provisoires** : états d'une fin de contrat (`preavis`, `export_disponible`, `a_l_ecart`, `effacee`) ; ajouter une valeur est additif.
6. **Visibilité** : une ligne par client (`UNIQUE (tenant_id, organisation_id)`), accords écrits en tableau de dates.

## Conséquences
- Aucune exception d'unicité (`EXCEPTIONS_UNICITE` reste vide). Aucune colonne de date d'effacement (C-623).
- Essais : `apps/api/src/db/bases-client.int.test.ts` (job `socle-integration`).
