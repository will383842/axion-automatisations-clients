# 0122 · Cycle de vie des versions et preuves de la procédure

Date : 07/11/2026 · Statut : proposé (T4-27a), à accepter par l'architecte · Contrat touché : C5 (deux entrées ajoutées à `TABLES_COMMUNES`, aucune règle changée ; C5 non gelé, ADR 0031) · Migration : `0027_cycle_de_vie_des_versions.sql` · S'appuie sur : ADR 0051 (catalogue, `catalogue_garde`)

## Contexte
- La machine d'états des versions (A-305) est déjà tenue en base par `catalogue_garde` (migration 0007). Un changement de statut n'y modifie aucune autre colonne, et une version figée ne change plus.
- La procédure d'entrée au catalogue (C-240) demande une preuve par étape, et certains passages portent une donnée : heure du passage en pilote (C-249), date de fin (B-461), remplaçante et prévenance (B-462).
- C-202 lit la liste des modèles testés d'une version.

## Décision
1. Aucune donnée posée au passage n'est rangée dans `versions_automatisation` : table `passages_version`, en ajout seul, heure du serveur imposée (aucun droit d'insertion sur `passe_le`).
2. Table `preuves_procedure`, en ajout seul, une preuve par (version, étape, empreinte). Une preuve d'un autre artefact ne compte pas.
3. Une seule colonne ajoutée à `versions_automatisation` : `modeles_testes text[]`, remplie pendant la recette, figée ensuite par `catalogue_garde`. `NULL` = rien mesuré (aucun modèle proposé).
4. Les deux tables sont communes (sans `tenant_id`) : RLS activée et forcée, écriture par `console_equipe` seule, aucun droit pour `console_app`, `console_lecture` ni `PUBLIC`, suppression refusée par `catalogue_garde`. L'auteur d'une ligne est l'acteur de la transaction (politique restrictive `auteur_acteur`).
5. Aucune fonction SQL nouvelle, aucune valeur d'énumération nouvelle ; `catalogue_garde` n'est pas réécrite.
6. Le CHECK posé sur la table existante est ajouté `NOT VALID` puis validé dans la même transaction.

## Options écartées
- Colonnes du cycle de vie dans `versions_automatisation` : impossible sans réécrire `catalogue_garde` (fonction du lot 2) ; non additif dans l'esprit.
- Lire l'heure du passage dans le journal d'audit : le journal sert à la trace, pas à une règle métier.
- Garde en base de la procédure (fonction) : une fonction de plus dans la liste fermée ; la base tient déjà le graphe, et un passage sans preuve échoue fermé côté serveur (aucune ligne de passage, aucune publication).
- Liste des modèles testés dans le manifeste C4 : c'est un fait de la recette, pas une déclaration de l'auteur ; cela évite aussi une révision de C4.

## Conséquences
- `TABLES_COMMUNES` passe de 30 à 32 entrées.
- La machine d'états côté serveur, la procédure et la route des versions sont livrées par T4-27b, sans migration, derrière un interrupteur fermé.
- T4-34b lit `modeles_testes` (C-202) ; le lot 6 ajoutera son droit de lecture du drapeau de la dernière étape dans sa propre migration.
- Une instance ne peut pas pointer une version `pilote` (`instances_garde`) : à régler par T4-28 avec l'architecte du lot 2.
- Retour arrière (documenté, jamais exécuté par la chaîne) : `REVOKE` seulement ; rien n'est détruit.
