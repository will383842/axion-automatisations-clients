# 0115 · Tables du lot 3

Date : 06/11/2026 · Statut : proposé (PR T3-05a #208 fusionnée sans ce fichier, puis PR T3-05b ; accord écrit de l'architecte à joindre à la PR T3-05b avant fusion) · Contrat touché : C5 (liste fermée `TABLES_COMMUNES`, ajout de six entrées) · Migrations : `0020_tables_lot_3_equipe.sql` (T3-05a), `0021_tables_lot_3_conformite.sql` (T3-05b)

## Contexte
- Les écrans du lot 3 (équipe, vues, « Aujourd'hui », conformité, historique des grilles) ont besoin de tables que les lots 2 et 2b ne créent pas. La fiche T3-05 les livre en deux migrations additives.
- Une table commune (sans `tenant_id`) est une exception fermée aux invariants C5 : chaque ajout à `TABLES_COMMUNES` demande un ADR et l'accord de l'architecte (CLAUDE.md §5). L'audit de la PR #208 l'a relevé (dette moyenne 1).

## Décision
1. **Six tables communes ajoutées à `TABLES_COMMUNES`** : `membres_equipe`, `absences`, `vues_enregistrees` (0020), `sous_traitants_ulterieurs`, `signatures_fiches`, `historique_grilles_prix` (0021). Elles sont **lues et écrites par `console_equipe` seul** : `console_app` n'a aucun droit, pas même `SELECT`, parce que la portée d'un membre et les filtres d'une vue citent des clients. RLS activée et forcée, journal par `audit_ecrire_equipe()`, acteur obligatoire, aucun `DELETE` ni `TRUNCATE` accordé.
2. **Un membre n'est jamais supprimé** : désactivé, il reste lisible (historique, absences, vues conservées mais non servies). La réactivation est interdite en V1 (nouvelle ligne avec un nouveau sujet, ou décision de l'architecte).
3. **Ajout seul pour la conformité** : `sous_traitants_ulterieurs`, `signatures_fiches` et `historique_grilles_prix` n'ont ni `UPDATE` ni `DELETE` ; une correction est une nouvelle ligne. L'auteur de la ligne est l'acteur de la requête. `historique_grilles_prix` porte de l'argent : montants en `bigint` de centimes, jamais de flottant, acteur toujours présent. Son champ libre s'appelle `raison` (« motif » est réservé aux énumérations, invariant 5).
4. **Aucun texte libre** (C-034) dans `demandes_droits`, `incidents_violations` et `aipd` (par client) : dates, énumérations, références de forme fermée, bornées par expression régulière et par `char_length`. L'échéance de notification d'une violation n'est pas modifiable. Les échéances sont calculées par l'API et rangées en dates : aucune durée légale n'est écrite dans la base.
5. **Prudence par défaut** : `registre_client.refus_transfert_hors_ue` vaut `true` par défaut.
6. **`automatisations.lit_contenu` (C-616) n'est pas dans la migration 0021** : sa déclaration vit dans `catalogue.ts`, hors des fichiers autorisés de la fiche (ESCALADE E1 du plan). L'ajouter en SQL seul ferait dériver l'instantané. La colonne attend la décision de l'architecte et une migration suivante.

## Conséquences
- Les migrations ne contiennent aucune fonction nouvelle, aucun `DROP`, `DELETE`, `TRUNCATE`, `RENAME` ni changement de type. Retour arrière à la main seulement : `REVOKE` des droits ajoutés ; tables, colonnes, types, index et contraintes restent.
- `vues_enregistrees` suppose que `app.acteur` est le sujet du membre (point F7) : à prouver côté API (T3-06) avant tout écran de vues.
- Une valeur d'énumération se règle plus tard par `ALTER TYPE … ADD VALUE`, qui reste additif.
