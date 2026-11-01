# 0046 · Bases des clients : une base par client dans la grappe « données »

Date : 01/11/2026 · Statut : proposé

Numéro 0046 : la fiche T2-31 demandait `0011-bases-des-clients.md`, mais 0011 est déjà pris (`0011-exception-cc-by-4-0-caniuse-lite.md`), de même que 0043 et 0044, et la PR n° 102 réserve 0045. L'ADR 0011 existant n'est pas touché.

## Contexte
L'ADR 0013 sépare deux grappes PostgreSQL : la commune (`console`, `moteur`, `keycloak`, `passerelle_ia`) et celle des bases de travail des clients. Cette décision règle la seconde : sa forme, ses noms, ses rôles, son PgBouncer et ses plafonds de connexions. Le risque principal est l'isolation entre clients.

## Décision
- Grappe `donnees-1` en V1 : un service `donnees` (même image que le socle, aucune image nouvelle), un volume à lui, le réseau `interne` seulement. Aucune des quatre bases de la grappe commune n'y existe, et aucune base `cli_` n'existe dans la commune.
- Une base PAR client. Pas de schéma par client et pas de RLS commune entre clients (C-497) : le schéma par client ne serait étudié qu'au-delà de 5 000 clients, ce qui est hors V1.
- Noms : base `cli_<id>` où `<id>` est formé des 12 premiers caractères hexadécimaux de l'UUID du client. Trois rôles par base :
  - `cli_<id>_proprietaire` : NOLOGIN, propriétaire de la base et de ses schémas (les migrations passent par lui) ;
  - `cli_<id>_app` : LOGIN, NOBYPASSRLS, ne possède rien ;
  - `cli_<id>_lecture` : LOGIN, SELECT seulement.
- Chaque base est fermée : `REVOKE CONNECT … FROM PUBLIC`, puis `GRANT CONNECT` aux seuls rôles du client. Le même retrait est posé sur `postgres`, `template0`, `template1` et `modele_vN`, pour qu'aucune base créée depuis eux n'hérite d'un droit.
- Création : un rôle `provisionneur` (CREATEDB et CREATEROLE, ni superutilisateur ni BYPASSRLS) exécute `ops/socle/donnees/creer-base.sql`. `CREATE DATABASE` ne peut pas tourner dans une transaction : ce n'est donc pas une fonction SQL mais une suite d'ordres que le provisionnement (T2-34) envoie hors transaction, en connexion DIRECTE (jamais par PgBouncer). Le modèle `modele_v<N>` vient de T2-32 ; ici un modèle vide d'essai.
- Limites par base (A-417), posées par `creer-base.sql` pour `_app` et `_lecture` : `statement_timeout`, `work_mem` borné, `CONNECTION LIMIT`. Les valeurs d'essai sont petites ; celles de production restent à définir au lot 8a.
- PgBouncer propre à la grappe (`pgbouncer-donnees`) : mode transaction, `server_idle_timeout = 30`, `default_pool_size = 2` et `max_db_connections = 2` par défaut ; les paliers 4 et 8 s'écrivent par base dans la section `[databases]` (le provisionnement, T2-34, écrit une ligne par client). Les rôles des clients sont connus par `auth_query` sur un rôle `pgbouncer_auth` limité aux noms `cli_…_app` et `cli_…_lecture` ; aucun fichier de mots de passe n'est versionné.
- Plafond global : 250 connexions serveur. PostgreSQL les applique (`max_connections` moins les places réservées au provisionneur et au superutilisateur) ; le cumul des `max_db_connections` est contrôlé par le provisionnement.

## Conséquences
- Ouvrir une base coûte un `CREATE DATABASE` de plus qu'un schéma, mais la sauvegarde, la destruction et la clé de chaque client restent séparées (ADR 0013).
- Les catalogues (`pg_database`, `pg_roles`) restent lisibles par tous les rôles : seuls des noms de la forme `cli_<12 hexadécimaux>` y paraissent, jamais une raison sociale.
- Limite connue : en PostgreSQL 16, le créateur d'un rôle garde l'option d'administration sur lui. `provisionneur` pourrait donc s'ajouter lui-même à un rôle d'un client. Le secret du provisionneur n'est tenu que par le provisionnement ; une séparation plus forte demande l'avis de l'architecte.
- Le compte des connexions est fait par PostgreSQL : au-delà de 250, un client attend puis reçoit un refus (délai d'attente de PgBouncer), les connexions déjà tenues par les autres bases ne sont pas coupées.
