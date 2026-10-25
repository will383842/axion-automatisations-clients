# @axion-auto/sdk-module

Kit pour écrire une automatisation : `defineAutomation` (contrat C4 v0), puis les réglages, la migration et les écrans.

## Réglages
- `validerReglages(module, valeurs)` : erreurs par champ, en français ; aucune valeur inconnue, à aucun niveau.
- `defauts(module)` : défauts tirés du schéma ; une option (booléen) vaut « désactivée » tant que le client ne l'active pas.
- Jamais de valeur en clair (adresse, mot de passe, jeton, URL avec identifiant) : une référence `connexion:<famille>`.

## Migration
- `migrerReglages(module, depuis, reglages, versions)` : garde les valeurs du client, met le défaut aux nouveaux champs.
- Échec = `MigrationRefusee` (`migration_refusee`) : l'instance reste sur l'ancienne version.
- `verifierMigrations(module, exemples, versionsPubliees)` : 100 rejeux par version, résultat identique exigé.

## Écrans
- `validerEcrans(ecrans)` : liste fermée de composants (`COMPOSANTS`) aux propriétés typées.
- Refusés : code, balises, gestionnaires `on…`, URL `javascript:`, couleurs hors teintes des jetons.
