# Socle en conteneurs jetables

Un seul moyen de lancer toutes les briques du socle, un seul job de CI (`socle-integration`).

## Lancer et arrêter
- `ops/socle/lancer.sh` : assemble `compose.base.yml` et tous les `compose.*.yml` (ordre alphabétique), génère un certificat auto-signé et les mots de passe de test, puis `docker compose up -d --wait`.
- `ops/socle/lancer.sh --assembler` : imprime le compose assemblé, sans démarrer.
- `ops/socle/arreter.sh` : arrête tout et supprime les volumes.
- Le fragment `compose.zz-essai-routage.yml` (services d'écho) n'est lu que sur la CI, ou avec `SOCLE_ESSAI=1`.

## Ajouter une brique
Créer `ops/socle/compose.<brique>.yml` : un fragment, jamais de changement du workflow. Un fragment plus loin dans l'ordre alphabétique peut redéfinir un service ; la garde s'applique au compose assemblé.
Règles (vérifiées par `scripts/garde-compose.ts`) :
- seul le proxy publie un port ;
- image épinglée par `@sha256:`, jamais `latest` ;
- ni `privileged`, ni `network_mode: host`, ni socket Docker ;
- les services internes (`postgres`, `pgbouncer`, `valkey`, `openbao`, `litellm`, `stockage`, `keycloak-admin`) restent sur le réseau `interne`, sans nom d'hôte ;
- seuls des noms en `.test`.

## Variables
- Noms d'hôte : `DOMAINE_CONSOLE`, `DOMAINE_PORTAIL`, `DOMAINE_API`, `DOMAINE_SSO` (par défaut `console.socle.test`, `client.socle.test`, `api.socle.test`, `sso.socle.test`).
- Mots de passe de test générés au lancement : `SOCLE_PG_MOT_DE_PASSE`, `SOCLE_VALKEY_MOT_DE_PASSE`, `SOCLE_KEYCLOAK_ADMIN_MOT_DE_PASSE`, `SOCLE_STOCKAGE_MOT_DE_PASSE`, `SOCLE_LITELLM_CLE_MAITRE`. Une valeur déjà présente dans l'environnement est conservée.
- `SOCLE_CERTS` : dossier du certificat (rempli par `lancer.sh`).

## Tests d'intégration
Les tests `*.int.test.ts` demandent le socle lancé : `SOCLE_INTEGRATION=1 pnpm exec vitest run --project integration`. Le projet `integration` est vide sans cette variable, donc `pnpm test` ne les lance pas. Dans la session cloud il n'y a pas de conteneurs : lire le job `socle-integration` de la PR.
