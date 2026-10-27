# Inventaire des secrets (A-115)

Chaque secret est listé par son NOM, jamais par sa valeur. La garde `scripts/garde-secrets-inventaire.ts` refuse :
- une variable lue par un fichier de `apps/*/src/` (hors tests), un fragment `ops/socle/compose.*.yml` ou `ops/compose.test.yml` qui n'est pas inscrite ici ;
- un secret de catégorie `equipe` rangé sous `clients/`, ou de catégorie `client` rangé sous `technique/` (sans tenir compte de la casse).

Catégories : `equipe` (outils et accès de l'équipe), `client` (secrets d'un client), `construction` (CI et essais, générés au lancement), `production`, `aucun` (variable lue qui n'est pas un secret).
Les secrets de l'équipe vivent dans Bitwarden ou sous `technique/` d'OpenBao, JAMAIS sous `clients/`.

## Variables lues par le code et le socle

| Nom | Catégorie | Lieu | Rotation |
|---|---|---|---|
| `NODE_ENV` | aucun | environnement cloud | sans objet |
| `PORT` | aucun | environnement cloud | sans objet |
| `APP_DATABASE_URL` | production | environnement cloud (le mot de passe vient d'OpenBao) | à chaque départ d'un administrateur |
| `MIGRATION_DATABASE_URL` | production | environnement cloud, le temps d'une migration (le mot de passe du rôle qui modifie le schéma vient d'OpenBao) | à chaque départ d'un administrateur |
| `APP_VERSION` | aucun | environnement de construction | sans objet |
| `HUB_URL` | aucun | environnement cloud | sans objet |
| `CRM_URL` | aucun | environnement cloud | sans objet |
| `CONSOLE_HUB_ACTIF` | aucun | environnement cloud (interrupteur du canal Hub, fermé par défaut) | sans objet |
| `CONSOLE_CRM_ACTIF` | aucun | environnement cloud (interrupteur du canal CRM, fermé par défaut) | sans objet |
| `PLAFOND_CLE_CLIENT_MICROCENTIMES` | aucun | environnement cloud | sans objet |
| `PLAFOND_PASSERELLE_JOUR_MICROCENTIMES` | aucun | environnement cloud | sans objet |
| `SEUIL_RYTHME_ANORMAL` | aucun | environnement cloud | sans objet |
| `DOMAINE_CONSOLE` | aucun | environnement de construction | sans objet |
| `DOMAINE_PORTAIL` | aucun | environnement de construction | sans objet |
| `DOMAINE_API` | aucun | environnement de construction | sans objet |
| `DOMAINE_SSO` | aucun | environnement de construction | sans objet |
| `SONDE_PORT_POSTGRES` | aucun | environnement de construction (port d'essai) | sans objet |
| `SONDE_PORT_PGBOUNCER` | aucun | environnement de construction (port d'essai) | sans objet |
| `SONDE_PORT_VALKEY` | aucun | environnement de construction (port d'essai) | sans objet |
| `SONDE_PORT_OPENBAO` | aucun | environnement de construction (port d'essai) | sans objet |
| `SONDE_PORT_KEYCLOAK` | aucun | environnement de construction (port d'essai) | sans objet |
| `SONDE_PORT_LITELLM` | aucun | environnement de construction (port d'essai) | sans objet |
| `SONDE_PORT_MAILPIT` | aucun | environnement de construction (port d'essai) | sans objet |
| `SONDE_PORT_MAILPIT_SMTP` | aucun | environnement de construction (port d'essai) | sans objet |
| `SOCLE_CERTS` | construction | environnement de construction | générés à chaque lancement |
| `SOCLE_PG_MOT_DE_PASSE` | construction | environnement de construction | généré à chaque lancement |
| `SOCLE_VALKEY_MOT_DE_PASSE` | construction | environnement de construction | généré à chaque lancement |
| `SOCLE_KEYCLOAK_ADMIN_MOT_DE_PASSE` | construction | environnement de construction | généré à chaque lancement |
| `SOCLE_KEYCLOAK_BD_MOT_DE_PASSE` | construction | environnement de construction | généré à chaque lancement |
| `SOCLE_KEYCLOAK_SECRET_CONSOLE` | construction | environnement de construction | généré à chaque lancement |
| `SOCLE_KEYCLOAK_SECRET_PORTAIL` | construction | environnement de construction | généré à chaque lancement |
| `KC_SECRET_CONSOLE` | production | environnement du conteneur Keycloak (substitué dans le fichier de royaume de l'équipe ; en essai, valeur de `SOCLE_KEYCLOAK_SECRET_CONSOLE`) | à chaque départ d'un administrateur |
| `KC_SECRET_PORTAIL` | production | environnement du conteneur Keycloak (substitué dans le fichier de royaume des clients ; en essai, valeur de `SOCLE_KEYCLOAK_SECRET_PORTAIL`) | à chaque départ d'un administrateur |
| `SOCLE_STOCKAGE_MOT_DE_PASSE` | construction | environnement de construction | généré à chaque lancement |

## Secrets rangés dans OpenBao

| Nom | Catégorie | Lieu | Rotation |
|---|---|---|---|
| `clients/<client>/...` | client | OpenBao `clients/` | à la demande du client |
| `technique/echanges/<canal>/<kid>` | equipe | OpenBao `technique/` | deux clés actives, chevauchement de 24 h |
| `modules-signature` | equipe | OpenBao transit (clé non exportable) | sur décision de l'architecte |
| `PART` | equipe | collection « parts » du gestionnaire de mots de passe (2 parts), responsable du produit, personne de confiance, copie hors ligne : un lieu par part (voir la procédure) | au changement d'un détenteur |
| `JETON_ROLE_API` | production | environnement cloud | période de 768 h, à recréer avant l'échéance |
| `JETON_ROLE_SECOURS` | equipe | Bitwarden | recréé avant chaque échéance |
| `INSTANTANE_RAFT` | equipe | stockage de secours chiffré, distinct du gestionnaire de mots de passe, avec d'autres membres | à chaque copie de secours |

## Secrets de la chaîne de déploiement

| Nom | Catégorie | Lieu | Rotation |
|---|---|---|---|
| `COOLIFY_JETON` | production | environnement GitHub réservé à `main` | chaque trimestre |
