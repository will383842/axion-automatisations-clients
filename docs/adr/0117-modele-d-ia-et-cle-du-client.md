# 0117 · Modèle d'IA et clé propre du client

Date : 06/11/2026 · Statut : proposé (audit de sécurité en 2 tours : `relecteur` puis `auditeur-securite`) · Contrat touché : aucun (C1 à C6 inchangés, rien dans `packages/contrats/`) · Migration : `0024_modele_ia_et_cle_client.sql` (T4-34a)

## Contexte
- Chaque appel d'IA d'un module passe par la passerelle, avec la clé virtuelle du client (IA incluse) ou avec la propre clé du client, rangée au coffre. Le modèle se choisit sur la fiche du client, puis automatisation par automatisation, dans une liste tenue par AXION IA.
- La clé d'un client est un secret : la base ne doit jamais la contenir, ni la console ni l'exécuteur la lire.

## Décision
1. **La clé du client n'existe en base que sous forme de référence** au coffre (`cles_ia_client.reference_coffre`, forme fermée `bao:clients/<tenant>/<uuid>`, liée au `tenant_id` de la ligne par un `CHECK`). Rangement par `rangerIdentifiant` sous le montage `clients/`, jamais sous `technique/` (clés d'AXION IA). Aucune colonne ne peut recevoir une valeur : la seule colonne libre bornée est `cree_par` (200, acteur).
2. **Une seule clé non désactivée par (client, organisation, fournisseur)** (index unique partiel). Une clé ne s'efface pas : elle se **désactive, définitivement** (politique restrictive : aucune modification d'une ligne désactivée). Remplacement = nouvelle ligne. `reference_coffre`, `fournisseur`, `organisation_id` et `cree_par` ne se modifient jamais (droits `UPDATE` par colonne). Aucun `DELETE` ni `TRUNCATE` accordé ; l'audit (`audit_ecrire`) trace chaque changement.
3. **Création seulement à l'état `a_tester`, avec un acteur** (`app.acteur`) égal à `cree_par` (politiques restrictives). `console_equipe` lit (`SELECT`) ; `console_lecture` n'a aucun droit.
4. **Modèle d'IA** : `instances.modele_ia` (surcharge de l'instance) et `organisations.modele_ia_defaut` (défaut du client) sont des **codes de forme fermée**, pas des clés étrangères : un modèle retiré de la liste d'AXION IA fait échouer proprement le choix (`modele_non_admis`). La forme de `modele_ia_defaut` est posée `NOT VALID` puis validée dans la même transaction : une valeur existante hors forme fait échouer la migration, qui est alors annulée en entier (échec fermé).
5. **La liste des modèles admis est de la configuration** (`apps/api/src/ia/modeles-admis.ts`), sans prix. Le refus « hors UE » (`registre_client.refus_transfert_hors_ue`, vrai par défaut) s'applique dans l'API (`choix.ts`) au modèle final, qu'il vienne du défaut du client, de la surcharge d'instance ou d'un réglage du module ; défaut Mistral. La base ne connaît pas la liste : aucune fonction ni déclencheur.
6. **`cles_ia_client` est créée ici, une seule fois**, avec les colonnes dont T4-54 a besoin (état, dernier essai, code du dernier refus, désactivation) ; T4-54 ne la recrée pas.
7. **Pas de route dans cette PR** : la garde C-536 (`scripts/liste-routes.ts`, hors fiche) exige qu'une route soit listée avec son essai « mauvais client ». Les fonctions (`cle-client.ts`) ne rendent jamais la valeur ni la référence : l'état seulement. Les routes de l'équipe viennent dans une PR suivante, interrupteur fermé par défaut.

## Conséquences
- La migration 0024 est additive : aucun `DROP`, `DELETE`, `TRUNCATE`, `RENAME` ni changement de type ; aucune fonction nouvelle, donc rien dans `scripts/garde-migrations-fonctions.json`. Elle tient dans une seule transaction.
- `instances` : `console_app` reçoit `SELECT`, `INSERT` et `UPDATE` sur la seule colonne `modele_ia` (droits par colonne, 0019). `instances_garde` et `instances_version_etat_voulu` ne changent pas.
- **Retour arrière** (à la main, jamais par `DROP`) : `REVOKE` des droits ajoutés (`console_app` et `console_equipe` sur `cles_ia_client`, les trois droits de colonne sur `instances.modele_ia`). Tables, types, index, contraintes et colonnes restent, vides ou non utilisés. Un retrait réel passe par une migration de contraction décidée par l'architecte.
- Reste à faire en T4-34b (sans migration) : client de la passerelle de l'exécuteur, coût en entiers (A-295), preuve des modèles testés par version (C-202), appels depuis un écran.
