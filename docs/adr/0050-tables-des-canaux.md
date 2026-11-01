# 0050 · Tables des canaux : boîte d'envoi, faits reçus, liens CRM, file « à trancher », exclusions

Date : 01/11/2026 · Statut : proposé (T2-02, maillon 3 de la chaîne des migrations) · Contrat touché : C5 (`invariants.ts`, liste `TABLES_COMMUNES`) — **à relire par l'architecte**

## Contexte
T2-02 pose, en une migration (`0006_canaux.sql`), les tables qui rendent le double envoi et le double traitement impossibles par la base. Aucune logique d'envoi ici (T2-14).

## Décision
1. **Unicités par client** : `boite_envoi (tenant_id, cle_anti_doublon)`, `faits_recus (tenant_id, source, event_id)`, `liens_crm (tenant_id, crm_company_id)`, `exclusions (tenant_id, empreinte_email)`. Aucune unicité globale (oracle d'existence entre clients, règle `unicite_sans_tenant`, ADR 0040). `EXCEPTIONS_UNICITE` reste vide.
2. **Ajout seul sur les champs d'identité** : `console_app` n'a qu'un `UPDATE` limité par colonnes (état, essais, prochain essai, erreur, réponse pour la boîte d'envoi ; traitement pour les faits ; état pour les liens et la file). La clé anti-doublon, le corps, l'`event_id` et l'empreinte d'e-mail ne changent jamais. Aucun `DELETE`, aucun `TRUNCATE`, aucun droit pour `PUBLIC` ni pour le portail (rôle absent de la base console).
3. **Fermeture de la file « à trancher »** : un `CHECK` (`a_trancher_cloture`) impose qu'une entrée `ouverte` n'ait ni décision ni auteur, et qu'une entrée `tranchee` ait les deux, non vides. Les deux côtés sont écrits avec `coalesce(…, 0)` : un `CHECK` laisse passer une valeur inconnue (`NULL`), ce qu'un essai contre PostgreSQL a révélé.
4. **Exclusions** : la table du client ne garde que l'empreinte SHA-256 en hexadécimal minuscule (`CHECK ^[0-9a-f]{64}$`), jamais l'e-mail. Sa colonne `portee` vaut toujours `client` (`CHECK`) : une ligne de portée plateforme n'a pas de client, elle vit dans `exclusions_plateforme`.
5. **Liste commune** `exclusions_plateforme` : table SANS `tenant_id`, inscrite dans la nouvelle liste fermée `TABLES_COMMUNES` de `packages/contrats/src/c5/invariants.ts` (T2-03 ne l'avait pas encore créée ; elle l'est ici avec cette seule entrée). Pour ces tables, et seulement quand la colonne `tenant_id` est absente, le contrôle C5 ne réclame plus `tenant_id`, son index ni une politique qui cite `tenant_id` ; RLS, `FORCE` et propriétaire restent exigés. Une table listée qui porterait un `tenant_id` suit les règles ordinaires. `CHECK` : motif ∈ {`rebond`, `plainte`}. Lecture par `console_app` et `console_equipe`, ajout par `console_equipe` seul, ni modification ni suppression.
6. **Audit** : `liens_crm` et `a_trancher` gardent le déclencheur `audit_ecrire`. `boite_envoi` et `faits_recus` (volume, ce sont déjà des registres) et `exclusions` (données de personnes sous forme d'empreinte, mécanisme d'effacement du journal pas encore choisi, ADR 0044) n'en ont pas.
7. **Vocabulaires provisoires** : méthode d'envoi, résultat d'un fait, motif et source d'une exclusion sont des énumérations ; ajouter une valeur est additif. `decision` de la file reste un texte libre non vide (T2-15 fixera les décisions possibles).
8. **Numéros** : ADR 0050 et migration `console` 0006, réservés par `spec/reservation-numeros.md`. Version de C5 inchangée (0.4.0) : l'exemption est limitée à une liste fermée et ne retire aucun contrôle aux tables à `tenant_id`.

## Conséquences
- Essais : `apps/api/src/db/schema/canaux.test.ts` (migration relue) et `apps/api/src/db/canaux.int.test.ts` (job `socle-integration`).
- Écart avec la fiche : `spec/compte-tests.json` et `spec/compte-tests-integration.json` n'existent pas dans le dépôt (le compteur est mesuré par la CI, ADR 0019) ; rien n'y est écrit.
- Aucune migration ne supprime ni ne renomme quoi que ce soit (N / N-1 respecté).
