# 0055 · Suivi du client : notes, demandes, cellules, thème, outils, audits, propositions, registre des traitements

Date : 02/11/2026 · Statut : proposé (T2-07, maillon 8 et dernier de la chaîne des migrations de `console`) · Contrat touché : aucun (C5 inchangé ; deux entrées s'ajoutent à la liste `TABLES_COMMUNES`, sans changer le sens d'un invariant) · Migration `console` 0011, à relire par l'architecte.

> **Le Hub fait foi** (ADR 0053). Rien ici ne porte un prix, un montant ni une TVA : les tables de suivi n'ont aucune colonne d'argent, donc rien à écrire en exonération et rien à recalculer. Une proposition garde son identifiant sur axion-ia.com, son statut et son nombre de paliers ; le prix reste au Hub.

## Contexte
T2-07 finit les entités de la base commune : la console ne garde que des **métadonnées** (C-034). Le texte d'une demande vit dans la base du client ; la console n'en a qu'un pointeur. La migration 0011 suppose les migrations 0009 (T2-05) et 0010 (T2-06) appliquées. Après sa fusion, la chaîne des migrations du lot 2 est close (T3-05 reprend ensuite les numéros 0012 et 0013 réservés).

## Décision
1. **Dix tables.** Huit tables de client par `tableClient()` (RLS activée et forcée, politiques du modèle, clés `(tenant_id, id)`, clés étrangères composées) : `notes`, `demandes`, `themes_client`, `outils_client`, `audits_client`, `besoins`, `propositions`, `propositions_automatisations`. Deux tables **communes** (sans `tenant_id`) : `cellules` et `registre_traitements`, ajoutées à `TABLES_COMMUNES` (écriture et lecture par `console_equipe` seul, journal de l'équipe).
2. **Demande sans texte libre (C-034).** `reference_texte` est un pointeur `demande:<uuid>` (format contrôlé, 64 caractères au plus, unique par client). Les autres textes de `demandes` sont un code court (`categorie`) et un nom borné (`responsable`). Aucune colonne `jsonb`, tableau ou binaire. Un test refuse tout nom de colonne qui ressemble à un texte (`texte`, `corps`, `contenu`, `message`, `description`…).
3. **Note de l'équipe** : texte court (1 à 1000 caractères), `auteur` = l'appelant (`app.acteur`) par politique restrictive, **ajout seul** pour l'application (ni `UPDATE`, ni `DELETE`). `audit: false` : le texte peut citer des personnes ; pas de copie au journal tant que le mécanisme d'effacement n'est pas choisi (ADR 0044, T2-11). La fin de conservation est calculée en T2-11 et déclenche une **proposition** de suppression soumise à Will, jamais un effacement automatique : pas de colonne ici.
4. **Cellule** : adresse interne, mode, capacité, nombre d'instances, version d'image, dernier signal de vie, état. **Aucun droit pour `console_app`** : l'adresse interne n'est pas pour les clients. Les fixtures de test utilisent des noms en `.test`. En V1 il n'y a qu'une cellule ; la base ne l'impose pas (A-134 partiel).
5. **Thème du client** : des **chemins de jetons de design** (`couleur.action`, `police.titre`), jamais une couleur écrite en dur ; les colonnes s'appellent `couleur_principale` et `couleur_accent` (la garde des colonnes refuse le mot « jeton »). Un seul thème actif par client (index unique partiel `(tenant_id) WHERE actif`). **Sans ligne active, le thème AXION s'applique** : `themeEffectif()` rend `THEME_AXION` (A-138 partiel ; le rendu vient aux lots 3 et 6).
6. **Outils, audits, besoins, propositions** : métadonnées seulement. Un besoin porte une catégorie (code), une priorité et un temps perdu estimé en **minutes** (entier borné) ; l'automatisation rapprochée est facultative. Un audit garde un identifiant sur axion-ia.com unique par client et une **référence** de compte rendu (jamais le texte). Une proposition est reçue dans l'état où le Hub l'a émise (statut libre, comme les devis de l'ADR 0053) ; ses automatisations et leur palier sont dans `propositions_automatisations` (ajout seul).
7. **Acteur obligatoire, sans repli sur « systeme »** : chaque table de client porte `acteur_obligatoire_insert` (et `_update` si une colonne est modifiable), politiques `RESTRICTIVE` sur `NULLIF(current_setting('app.acteur', true), '')`. Les tables communes font de même pour `console_equipe`.
8. **Droits** : aucun `DELETE`, aucun `TRUNCATE`, rien pour `PUBLIC`. `UPDATE` par colonnes seulement : `demandes` (`statut`, `priorite`, `responsable` ; une demande naît `nouvelle`, `close` est définitif), `themes_client`, `outils_client`, `audits_client` (`compte_rendu_ref`), `besoins`, `propositions` (`statut`). Pas de `SELECT *` ni de `RETURNING *` : `console_app` ne lit pas les colonnes d'origine d'`instances` (C-676).
9. **Aucune fonction nouvelle** : aucun `CREATE FUNCTION`, donc aucune empreinte dans `scripts/garde-migrations-fonctions.json`. La garde de « close est définitif » est une politique restrictive qui lit la ligne en cours de mise à jour (pas de sous-requête, donc pas de lecture périmée en READ COMMITTED).
10. **Unicités** toutes préfixées par `tenant_id` (`EXCEPTIONS_UNICITE` reste vide) ; bornes sur chaque entier ; aucun `bigint` dans ces tables.
11. **Garde des textes** (`garde-colonnes.test.ts`) : dans `demandes`, `executions` et `alertes`, toute colonne `text` est dans une liste fermée avec sa longueur maximale et le schéma la borne (`char_length` ou motif à quantificateur borné). Les trois colonnes encore sans borne (voir Dettes) forment une liste de dette fermée.
12. **Journal et instantané Drizzle** : l'entrée 11 suit l'entrée 10. L'instantané 0011 est régénéré par drizzle-kit à partir du schéma TypeScript ; son `prevId` est l'`id` de 0010. **Aucune table existante ne change** : un test charge les deux instantanés et exige que chaque table et chaque énumération de 0010 soit identique dans 0011.

## Conséquences
- Migration additive : aucun `DROP`, aucun renommage.
- Les essais d'intégration (`suivi.int.test.ts`, job `socle-integration`) sont la preuve des politiques ; les contrôles textuels de `suivi.test.ts` ne comptent pas comme preuve.
- `spec/compte-tests.json` et `spec/compte-tests-integration.json` n'existent plus (garde de l'outillage) : aucun compte à mettre à jour.

## Dettes
- **Colonnes de texte sans longueur maximale (C-034)** : `executions.auteur`, `executions.termine_par` et `alertes.assignee_a` (T2-06) n'ont qu'un contrôle de non-vide. Les borner demande de changer `schema/exploitation.ts` et d'ajouter une contrainte (par exemple `ADD CONSTRAINT … CHECK (char_length(col) <= 200) NOT VALID`, puis `VALIDATE CONSTRAINT` après vérification des lignes de production), hors des fichiers autorisés de T2-07 et après la fin de la chaîne : à porter par une tâche dédiée, avant laquelle la liste `TEXTE_SANS_LIMITE_DETTE` ne grandit pas et doit se vider. Propriétaire : T2-52.
- **Une seule cellule en V1** : la base n'impose ni ce plafond ni un lien instance → cellule ; le nombre d'instances d'une cellule est une valeur saisie, pas un calcul. À reprendre avec l'exécuteur. Propriétaire : T4-22.
- **Registre des traitements** : la table existe et ses colonnes sont contrôlées ; **le contenu des lignes (finalités, durées) reste à écrire** (rédigé par l'IA, validé par Will) ; il reprendra : 24 mois avant PROPOSITION de suppression, jamais de purge automatique des données clients, IP du journal d'audit en HMAC ; aucune ligne n'est insérée par la migration. Propriétaire : T2-11.
- **Compte rendu d'audit, description du besoin** : A-151 et A-152 citent un compte rendu et une description ; seul un pointeur (`compte_rendu_ref`) existe pour le premier, le second n'a pas de texte (catégorie en code), par minimisation. À confirmer avec l'architecte. Propriétaire : T2-52.
- **Propositions** : A-153 cite aussi des prix et des vidéos jointes ; les prix restent au Hub (aucun prix ici) et les vidéos ne sont pas rangées. Le rapprochement avec le Hub reste à faire. Propriétaire : T2-52.
- **Fin de conservation des notes** : calculée en T2-11 ; elle déclenche une **proposition** de suppression soumise à Will, jamais un effacement automatique ; tant qu'elle manque, une note reste en place. Propriétaire : T2-11.
- **Statut de proposition réécrivable depuis un état final** : `GRANT UPDATE (statut)` sans règle de transition ni `statut_par`. Propriétaire : T2-52 (contrôle de nuit contre le Hub).
- **`close` définitif sur les demandes** : la mise à jour renvoie `rowCount` 0 sans erreur. L'appelant doit traiter `rowCount = 0` comme un refus. Propriétaire : T2-11.
- **Repli `système` de `audit_ecrire`** pour un rôle propriétaire (`0007_catalogue.sql` vers la ligne 365, et `audit_ecrire_equipe` vers la ligne 316) : à traiter dans une tâche dédiée. Propriétaire : T2-11.
- **Notes hors journal d'audit** : seules les métadonnées sont à journaliser. Propriétaire : T2-11.
- **`cellules.adresse_interne`** accepte une IPv4 brute : ajouter `AND adresse_interne !~ '^[0-9.]+$'` dans une migration future. Propriétaire : T2-52.
- **`demandes.responsable`** est un nom en clair : préférer un identifiant de compte. Propriétaire : T2-52.
- **`propositions_automatisations`** : le palier n'est pas comparé à `propositions.nombre_paliers`, et `audit_id` peut viser une autre organisation du même client. Propriétaire : T2-52.
- **Garde des colonnes** (`garde-colonnes.test.ts`, `borne()` vers la ligne 58) accepte un motif qui finit par `{m,n}$` même non borné avant (ex. `^.*[a-z]{0,5}$`) : à durcir. Propriétaire : T2-52.
- **Acteur obligatoire** : aucun essai sur `UPDATE` de `cellules` et de `registre_traitements`. Propriétaire : T2-11.
- **Valeur par défaut `instances.etat = 'active'`** (dette de l'ADR 0053) : inchangée. Propriétaire : T2-52.

## Futures fiches
- **T2-52 · migration de durcissement du lot 2, à ouvrir après T2-11.** Elle porte neuf dettes de cette liste. T2-08 (héritage et plan commercial) est une tâche terminée et sans migration : elle n'en porte aucune.
  1. Colonnes de texte sans longueur maximale (`executions.auteur`, `executions.termine_par`, `alertes.assignee_a`), puis vider `TEXTE_SANS_LIMITE_DETTE`.
  2. Compte rendu d'audit et description du besoin (A-151, A-152).
  3. Propositions : prix, vidéos jointes et rapprochement avec le Hub (A-153).
  4. Statut de proposition réécrivable depuis un état final.
  5. `cellules.adresse_interne` : refuser une IPv4 brute.
  6. `demandes.responsable` : un identifiant de compte, pas un nom en clair.
  7. `propositions_automatisations` : palier comparé à `propositions.nombre_paliers`, `audit_id` de la même organisation.
  8. `borne()` de `garde-colonnes.test.ts` à durcir.
  9. `instances.etat` : retirer la valeur par défaut `active`.
  Les dettes de T2-08 elles-mêmes (source « metier », garantie, délai, seuil, motif, version de départ lue par l'équipe) : propriétaire T2-52, sauf B-515 et `verifierEcriture`/`imposee` (T4-30).

- **Rétention T2-11 · dépôt des propositions de suppression de notes** : `proposerSuppressionNotes` appelle `soumettreProposition` ; la table ou la file qui reçoit la proposition destinée à Will (identifiants des notes, client, date de fin de contrat) et l'adaptateur SQL (lecture client par client, `nouveauContratApres`) restent à écrire. Aucune suppression automatique n'existe dans le code. Propriétaire : T2-21 (porte du lot 2). Critère de test : avec une note dont le contrat a fini il y a plus de 3 ans, interrupteur ouvert, une proposition apparaît pour Will et la note existe toujours ; un client avec un nouveau contrat n'en reçoit pas ; deux passages successifs (deux nuits) ne laissent qu'UNE proposition par (client, date de fin de contrat) (`soumettreProposition` est idempotente, contrat du port : `INSERT … ON CONFLICT DO NOTHING`, renvoie faux au second passage), base réelle.
