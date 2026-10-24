# 0009 · Garde des permissions statuses et checks : ce qu'elle détecte, ce qui l'empêche vraiment

Date : 24/10/2026 · Statut : accepté

## Contexte
Un workflow qui obtient `statuses: write` ou `checks: write` pourrait poser lui-même un faux contrôle « garde-fusion » sur une PR. La garde `scripts/garde-workflows.ts` refuse ces droits, et `ops/verifier-reglages-depot.sh` la relance sur les fichiers présents.

## Décision
La garde fonctionne en liste blanche, ligne à ligne : une clé `statuses` ou `checks` n'est acceptée que si `read` ou `none` suit sur la même ligne. Une valeur `permissions:` doit être un bloc, `read-all` ou `{}`. Ancres, alias, étiquettes, clés explicites et fusions YAML sont refusés dans tout workflow. Aucun workflow existant n'en utilise.

## Analyseur YAML (relecture de la correction)
La lecture ligne à ligne seule ne tient pas : chaque forme de YAML valide (clé entre guillemets, espace avant les deux-points, job en flux, `#` dans une chaîne, clé échappée `\x73tatuses`, clé explicite `?` en flux) la contourne. Choix : `js-yaml` 4.3.2, licence MIT, version exacte épinglée, déjà dans le lockfile, déclaré en dépendance de développement du paquet racine (celui qui contient `scripts/`). Il n'exécute aucun code (schéma par défaut, étiquettes inconnues refusées).
- Toutes les valeurs dont la clé vaut `permissions` sont parcourues, à tout niveau. Refus si la valeur n'est ni `read-all`, ni un objet (donc `write-all` refusé, `{}` accepté).
- Dans l'objet, `statuses` et `checks` doivent valoir `read` ou `none`.
- Ancres, alias et fusions : refusés. Un YAML illisible est refusé.
- La lecture ligne à ligne reste en seconde barrière ; elle ne coupe plus sur `#` à l'intérieur d'une chaîne entre guillemets.

## Limite de fond
La garde DÉTECTE, elle n'EMPÊCHE rien. Un workflow modifié dans une PR depuis une branche du dépôt s'exécute dans la même vague de CI que la garde, et peut poser son statut avant qu'elle ne tombe au rouge.

La vraie parade est dans les réglages du dépôt : le contrôle requis `garde-fusion` doit être lié à une application dédiée (`required_status_checks.checks[].app_id`). Un statut posé par `github-actions` ne compterait alors pas.

## Conséquences
- Tâche de suite (réglages, chef d'orchestre) : lier `garde-fusion` à l'application dédiée, puis faire lire `app_id` par `ops/verifier-reglages-depot.sh` (il ne lit aujourd'hui que `.checks[].context`).
- Un `run:` qui contient le texte `checks: write` est refusé : faux positif accepté pour une garde de sécurité.
- Le script de vérification ne dit jamais OK par défaut : dossier absent ou garde en échec donne « À CORRIGER … non vérifiable ».
