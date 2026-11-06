# 0113 · Courtier : remise du rôle `cli_<id>_lecture` à l'exécuteur, avec rotation et coupure

Date : 06/11/2026 · Statut : accepté (arbitrage de l'architecte du 06/11/2026, escalade de T4-50d) · Contrat touché : aucun · Migration : aucune · Modifie : ADR 0046 (« Rôles » et « Rotation des mots de passe ») et la règle de `ops/socle/openbao/donnees.hcl`

## Contexte
- Le courtier ne remet à l'exécuteur qu'un seul identifiant de base : `cli_<id>_app` (LOGIN, NOBYPASSRLS, droits d'écriture). La politique `donnees` d'OpenBao ne lit que `technique/data/donnees/+/app` et exclut nommément le secret `lecture`.
- Le port `donnees` (T4-50d, requêtes déclarées en structure, ADR 0109 et 0112) ne fait que des lectures. Les servir avec `_app` donnerait à une lecture un rôle qui peut écrire : une faute du générateur ou du port deviendrait une écriture. Règle posée : une lecture du port `donnees` ne passe jamais par `_app`.
- `cli_<id>_lecture` (SELECT seulement) existe déjà dans chaque base (ADR 0046), mais son mot de passe ne tourne pas, il n'a pas de `VALID UNTIL`, et la coupure au gel ou à la rotation ne vise que `_app` et les rôles dynamiques humains rattachés à `_lecture`.

## Décision
- Le courtier remet `cli_<id>_lecture` pour les lectures déclarées d'une tâche, et `_app` reste remis pour le reste, inchangé. Le genre (`app` ou `lecture`) est une constante du code de chaque route, jamais un champ de la requête ; la remise de lecture a un type fixe `base_lecture` et le nom du rôle n'est jamais transmis par l'exécuteur.
- Condition : `_lecture` n'est servi que s'il TOURNE comme `_app`.
  - Rotation : le pivot fait tourner `_app` puis `_lecture` sous le même verrou par client ; chaque rôle a son secret `technique/donnees/<base>/<genre>`, sa version notée en `COMMENT` et son `VALID UNTIL` (deux périodes après la dernière rotation). Même ordre que l'ADR 0046 : coffre d'abord, rôle ensuite ; version du coffre différente de celle du rôle → refus `secret_incoherent`.
  - Un `_lecture` sans `VALID UNTIL` n'est pas servi (`role_sans_echeance`). Un `_lecture` sans `statement_timeout` positif ou sans `CONNECTION LIMIT` n'est pas servi (A-417), comme `_app`.
  - Noms acceptés partout (changement de mot de passe, limites, validité) : `^cli_[0-9a-f]{12}_(app|lecture)$` ; lecture du coffre par le courtier en liste fermée `app|lecture`. `_proprietaire` et tout autre nom restent refusés.
- Coupure : au gel et à la rotation immédiate, les sessions de `cli_<id>_lecture` sont coupées en plus de celles de `_app` (`pg_terminate_backend` sur `usename = <base>_lecture`, en plus de `KILL` puis `RESUME` de la base dans PgBouncer).
- Modification de l'ADR 0046 :
  - Rôles : `cli_<id>_lecture` devient aussi l'identifiant remis à l'exécuteur pour les lectures déclarées ; il n'est plus réservé à la console et au rattachement des rôles humains.
  - Rotation : « un seul rôle fixe `cli_<id>_app` et `VALID UNTIL` » devient « deux rôles fixes `cli_<id>_app` et `cli_<id>_lecture`, chacun avec `VALID UNTIL`, tournés sous le même verrou ». Le reste (pas de rôles alternés, ordre coffre puis rôle, `secret_incoherent`, période de grâce, `jobId` par base et période) vaut pour les deux.
- Modification de `ops/socle/openbao/donnees.hcl` : le secret `lecture` n'est plus exclu. La politique lit `technique/data/donnees/+/app`, `technique/data/donnees/+/lecture` et leurs `metadata`, en `read` seulement ; toujours rien sur `proprietaire`, `provisionneur`, l'administration de PgBouncer ni le moteur `database/`. Le commentaire du fichier est réécrit dans ce sens.
- Bornes : aucun changement de `auth_query` (il connaît déjà `cli_…_lecture`), de `pg_hba`, de `CONNECTION LIMIT` ni de `api.hcl`. S'il faut en toucher un : ESCALADE.

## Options écartées
- `SET LOCAL ROLE cli_<id>_lecture` depuis une connexion `_app` : la session reste ouverte avec `_app`, un `RESET ROLE` ou une faute la ramène aux droits d'écriture ; c'est précisément ce que la règle interdit.
- Rôle dynamique OpenBao par exécution (comme l'accès humain de T2-36b) : meilleure séparation, mais ces noms sont inconnus de `auth_query`, de `pg_hba`, de `fermer_client` et des contrôles de noms du provisionnement, et doublent les limites A-417 à tenir. C'est la cible si l'audit juge la rotation de `_lecture` insuffisante ; il faudra alors un nouvel ADR.
- Faire passer les lectures par l'API : un aller-retour de plus par lecture, et l'API deviendrait un lecteur général des bases des clients, contraire au cloisonnement par le courtier.

## Conséquences
- `CONNECTION LIMIT` de `_lecture` (2 en essai) est partagée entre la console et l'exécuteur du même client. Le test `[A-170]` le vérifie (une lecture de l'exécuteur et une de la console tiennent ensemble). S'il échoue : nouvel ADR sur la limite ; on ne la relève pas en douce.
- Effet de bord annoncé : chaque rotation de `_lecture` coupe aussi les lectures en cours de la console pour ce client ; la console doit rouvrir sa connexion (à vérifier par T4-39b-1).
- Bases existantes : leur `_lecture` n'a ni version en `COMMENT` ni `VALID UNTIL`, donc il ne serait pas servi. Une rotation de rattrapage est lancée par la session de déploiement après la fusion de T4-39b-1.
- Ordre : T4-39b-1 (rotation et coupure) avant T4-39b-2 (remise) ; T4-50d dépend de T4-39b-2. Risque haut : audit sécurité Opus en deux tours, relecture allégée interdite.
- Le gel, la rotation et la validité couvrent désormais deux rôles de connexion par client : toute vérification nominative de `_app` dans les gardes et les tests est à étendre à `_lecture`.

## Critères de test (fiche T4-39b)
- `[C-624] @isolation l'identifiant de lecture remis pour une tâche de A ne se connecte pas à cli_<B>` (intégration).
- `[C-624] @isolation une tâche forgée ou d'un autre client ne reçoit pas le rôle _lecture de A (tache_etrangere)`.
- `[C-624] le rôle remis pour la lecture est cli_<id>_lecture et INSERT/UPDATE/DELETE y échouent` (intégration).
- `[A-209] aucun nom hors cli_<id>_(app|lecture) n'est interrogé ni servi (_proprietaire refusé)`.
- `[A-055] seuls api.hcl et donnees.hcl lisent technique/data/donnees/+/lecture ; aucun ne lit /proprietaire`.
- `[A-169] la rotation de _lecture pose VALID UNTIL ; entre coffre et rôle le courtier refuse secret_incoherent`.
- `[A-169] un _lecture sans VALID UNTIL n'est pas servi`.
- `[A-417] un _lecture sans statement_timeout positif ou sans CONNECTION LIMIT n'est pas servi`.
- `[C-035] le gel coupe aussi les sessions de cli_<id>_lecture` (intégration).
- `[A-170] une lecture de l'exécuteur et une lecture de la console du même client tiennent sous CONNECTION LIMIT 2` (intégration).
- Attaques pour l'audit : champ « genre » ou « role » ajouté à la requête ; chemin `../proprietaire` ; remise rejouée après un gel ; secret `_lecture` rangé mais pas encore posé sur le rôle ; coupure sans PgBouncer.
