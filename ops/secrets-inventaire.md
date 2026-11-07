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
| `CONSOLE_CONNEXION_OUVERTE` | aucun | environnement cloud (interrupteur, fermé par défaut) | sans objet |
| `CONSOLE_EMETTEUR_OIDC` | aucun | environnement cloud (adresse du royaume de l'équipe) | sans objet |
| `CONSOLE_CLIENT_OIDC` | aucun | environnement cloud | sans objet |
| `CONSOLE_SECRET_OIDC` | equipe | OpenBao `technique/` (secret du client `console` de Keycloak) | chaque trimestre |
| `CONSOLE_ORIGINE` | aucun | environnement cloud (origine publique de la console) | sans objet |
| `BACKOFFICE_URL` | aucun | environnement cloud (A-104) | sans objet |
| `MIGRATION_DATABASE_URL` | production | environnement cloud, le temps d'une migration (le mot de passe du rôle qui modifie le schéma vient d'OpenBao) | à chaque départ d'un administrateur |
| `APP_VERSION` | aucun | environnement de construction | sans objet |
| `SENTRY_DSN` | equipe | OpenBao `technique/` (adresse d'envoi des erreurs, région européenne seulement ; absente : aucun signalement, la console démarre sans) | à chaque changement de projet Sentry |
| `SENTRY_ECHANTILLONNAGE` | aucun | environnement cloud (taux de 0 à 1, 0 par défaut ; les transactions sont de toute façon retirées avant l'envoi) | sans objet |
| `SENTRY_CELLULE` | aucun | environnement cloud (nom de la cellule, étiquette des erreurs) | sans objet |
| `JOURNAUX_RETENTION` | aucun | environnement cloud (durée de conservation des journaux regroupés ; valeur provisoire, fixée au lot 8a) | sans objet |
| `JOURNAUX_PLAFOND_OCTETS` | aucun | environnement cloud (taille disque maximale des journaux regroupés ; valeur provisoire, fixée au lot 8a) | sans objet |
| `NEXT_RUNTIME` | aucun | posée par Next lui-même (moteur nodejs ou edge) ; lue par l'instrumentation de la console | sans objet |
| `HUB_URL` | aucun | environnement cloud | sans objet |
| `WEBHOOKS_OUVERTS` | aucun | environnement cloud (interrupteur, fermé par défaut) | sans objet |
| `GMAIL_URL` | aucun | environnement cloud | sans objet |
| `CONNECTEUR_GMAIL_OUVERT` | aucun | environnement cloud | sans objet |
| `CONNECTEURS_MESSAGERIE_OUVERT` | aucun | environnement cloud | sans objet |
| `CRM_URL` | aucun | environnement cloud | sans objet |
| `CONSOLE_HUB_ACTIF` | aucun | environnement cloud (interrupteur du canal Hub, fermé par défaut) | sans objet |
| `CONSOLE_CRM_ACTIF` | aucun | environnement cloud (interrupteur du canal CRM, fermé par défaut) | sans objet |
| `EXECUTEUR_API_OUVERTE` | aucun | environnement cloud (interrupteur des routes de l'exécuteur, configuration et état voulu ; fermé par défaut) | sans objet |
| `EXECUTEUR_DONNEES_HOTES` | aucun | environnement cloud (liste fermée des hôtes de la grappe de bases que le courtier peut remettre au port données ; obligatoire) | sans objet |
| `EQUIPE_ADRESSE_WILL` | aucun | environnement cloud (adresse de l'équipe pour les e-mails de service ; une adresse, pas un secret) | sans objet |
| `RETENTION_PURGE_ACTIVE` | aucun | environnement cloud (interrupteur du retrait des exécutions anciennes et de la proposition de suppression des notes à Will, fermé par défaut ; aucune note n'est effacée automatiquement) | sans objet |
| `SAUVEGARDES_RETRAIT_ACTIF` | aucun | environnement cloud (interrupteur du retrait des anciens dumps de client sur la cible de sauvegarde, fermé par défaut ; suspendu par un gel pour litige) | sans objet |
| `EXPORTS_RETRAIT_ACTIF` | aucun | environnement cloud (interrupteur du retrait de la copie d'export au bout de 30 jours ; ne touche jamais la donnée d'origine ; fermé par défaut, suspendu par un gel pour litige) | sans objet |
| `RETENTION_OUVERTE_PAR` | aucun | environnement cloud (date d'ouverture du retrait, posée par Will ; exigée en production si l'interrupteur est ouvert) | sans objet |
| `EFFACEMENT_ACTIF` | aucun | environnement cloud (interrupteur de l'effacement exceptionnel d'un client, au clic tracé de Will seulement ; fermé par défaut, jamais ouvert par une routine ; suspendu par un gel pour litige) | sans objet |
| `EFFACEMENT_OUVERT_PAR` | aucun | environnement cloud (date d'ouverture de l'effacement, posée par Will ; exigée en production si l'interrupteur est ouvert) | sans objet |
| `CONTRACTER_OUVERT` | aucun | environnement cloud (interrupteur des migrations « contracter » des bases des clients, fermé par défaut, y compris en production ; ouvert par Will seul, lot 8a) | sans objet |
| `VERSION_STRUCTURE_CODE` | aucun | environnement cloud (version de structure des bases attendue par le code déployé ; absente = inconnue, contracter refusé) | sans objet |
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
| `SOCLE_KEYCLOAK_SECRET_CONSOLE_SESSIONS` | construction | environnement de construction | généré à chaque lancement |
| `SOCLE_KEYCLOAK_SECRET_PORTAIL` | construction | environnement de construction | généré à chaque lancement |
| `KC_SECRET_CONSOLE` | production | environnement du conteneur Keycloak (substitué dans le fichier de royaume de l'équipe ; en essai, valeur de `SOCLE_KEYCLOAK_SECRET_CONSOLE`) | à chaque départ d'un administrateur |
| `KC_SECRET_CONSOLE_SESSIONS` | production | OpenBao `technique/` ; lu par l'API seule (compte de service `console-sessions` du royaume de l'équipe) et substitué dans le fichier de royaume de l'équipe ; en essai, valeur de `SOCLE_KEYCLOAK_SECRET_CONSOLE_SESSIONS` | à chaque départ d'un administrateur |
| `KC_SECRET_PORTAIL` | production | environnement du conteneur Keycloak (substitué dans le fichier de royaume des clients ; en essai, valeur de `SOCLE_KEYCLOAK_SECRET_PORTAIL`) | à chaque départ d'un administrateur |
| `KC_ORIGINE_CONSOLE` | aucun | environnement du conteneur Keycloak (origine publique de la console, substituée dans les adresses de rappel et de fin de session du client `console` ; en essai, l'adresse fictive https://console.exemple.test) | sans objet |
| `SOCLE_STOCKAGE_MOT_DE_PASSE` | construction | environnement de construction | généré à chaque lancement |

## Secrets rangés dans OpenBao

| Nom | Catégorie | Lieu | Rotation |
|---|---|---|---|
| `clients/<client>/...` | client | OpenBao `clients/` | à la demande du client |
| `technique/donnees/cli_<id>/<rôle>` | equipe | OpenBao `technique/` (mots de passe de la base d'un client, générés par le provisionnement, écrits sans relecture par le rôle OpenBao provisionneur) | à la demande, par le courtier (T2-36) |
| `technique/donnees/cli_<id>/app` | equipe | OpenBao `technique/` (mot de passe de l'exécuteur, renouvelé par la rotation du courtier, lu par le courtier seul) | 30 jours (période configurable), aussitôt en cas d'incident |
| `DONNEES_GESTION_MOT_DE_PASSE` | equipe | compte de gestion du moteur database d'OpenBao sur la grappe données (secret `technique/`, lu à l'initialisation seulement) | à chaque départ d'un détenteur |
| `DONNEES` | equipe | jeton OpenBao du courtier des bases (politique `donnees` : secret app d'un client, pour l'exécuteur seulement) | période de 768 h, à recréer avant l'échéance |
| `HUMAINS` | equipe | jeton OpenBao de l'accès humain tracé (politique `humains` : identifiants dynamiques de lecture et révocation des baux, jamais le secret de l'exécuteur) | période de 768 h, à recréer avant l'échéance |
| `technique/echanges/<canal>/<kid>` | equipe | OpenBao `technique/` | deux clés actives, chevauchement de 24 h |
| `modules-signature` | equipe | OpenBao transit (clé non exportable) | sur décision de l'architecte |
| `PART` | equipe | collection « parts » du gestionnaire de mots de passe (2 parts), responsable du produit, personne de confiance, copie hors ligne : un lieu par part (voir la procédure) | au changement d'un détenteur |
| `JETON_ROLE_API` | production | environnement cloud | période de 768 h, à recréer avant l'échéance |
| `JETON_ROLE_SECOURS` | equipe | Bitwarden | recréé avant chaque échéance |
| `INSTANTANE_RAFT` | equipe | stockage de secours chiffré, distinct du gestionnaire de mots de passe, avec d'autres membres | à chaque copie de secours |
| `PHRASE_SAUVEGARDES` | equipe | OpenBao `technique/sauvegardes` (32 octets aléatoires au moins), plus une copie hors ligne (même règle que les parts : un lieu, pas Bitwarden seul) | nouvelle phrase = nouveau dépôt ou nouvelle stanza ; ancien dépôt et ancienne phrase gardés jusqu'à expiration (pgBackRest ne change pas la phrase d'un dépôt existant) |

## Secrets de la chaîne de déploiement

| Nom | Catégorie | Lieu | Rotation |
|---|---|---|---|
| `COOLIFY_JETON` | production | environnement GitHub réservé à `main` | chaque trimestre |
