-- Recette de création d'une base client (T2-31, ADR 0046), jouée par le provisionneur, en connexion DIRECTE (jamais par PgBouncer) :
--   psql -U provisionneur -d postgres -v id=<12 premiers caractères hexadécimaux de l'UUID> -f creer-base.sql
-- avec CLI_MDP_APP et CLI_MDP_LECTURE dans l'environnement (mots de passe générés par le provisionnement, jamais écrits ici).
-- CREATE DATABASE ne peut pas tourner dans une transaction : ce n'est pas une fonction, mais une suite d'ordres envoyés hors transaction (T2-34 les envoie).
-- Sans « id » (cas de l'initialisation de la grappe, qui joue tous les scripts du dossier) le script ne fait rien.
\if :{?id}
\set ON_ERROR_STOP on
-- Valeurs d'essai, petites ; celles de la production sont à définir au lot 8a. Chacune se remplace par -v.
\if :{?modele} \else \set modele modele_v1 \endif
\if :{?delai} \else \set delai 5s \endif
\if :{?memoire} \else \set memoire 4MB \endif
\if :{?limite_app} \else \set limite_app 4 \endif
\if :{?limite_lecture} \else \set limite_lecture 2 \endif

SELECT :'id' ~ '^[0-9a-f]{12}$' AS id_valide \gset
\if :id_valide
\else
  DO $$ BEGIN RAISE EXCEPTION 'creer-base : id invalide (12 caractères hexadécimaux attendus)'; END $$;
\endif
\getenv mdp_app CLI_MDP_APP
\getenv mdp_lecture CLI_MDP_LECTURE
SELECT 'cli_' || :'id' AS base, 'cli_' || :'id' || '_proprietaire' AS proprio, 'cli_' || :'id' || '_app' AS app, 'cli_' || :'id' || '_lecture' AS lecture \gset

-- Les trois rôles. Le propriétaire ne se connecte pas ; l'application ne possède rien ; la lecture ne fait que lire.
CREATE ROLE :"proprio" NOLOGIN NOBYPASSRLS;
CREATE ROLE :"app" LOGIN NOBYPASSRLS NOINHERIT CONNECTION LIMIT :limite_app PASSWORD :'mdp_app';
CREATE ROLE :"lecture" LOGIN NOBYPASSRLS NOINHERIT CONNECTION LIMIT :limite_lecture PASSWORD :'mdp_lecture';
-- Limites par rôle (A-417) : une requête trop longue est coupée, la mémoire de travail est bornée.
ALTER ROLE :"app" SET statement_timeout = :'delai';
ALTER ROLE :"app" SET work_mem = :'memoire';
ALTER ROLE :"lecture" SET statement_timeout = :'delai';
ALTER ROLE :"lecture" SET work_mem = :'memoire';

-- Le provisionneur n'agit en propriétaire que le temps de la recette (droit retiré à la fin).
GRANT :"proprio" TO CURRENT_USER WITH SET TRUE;
CREATE DATABASE :"base" TEMPLATE :"modele" OWNER :"proprio";
SET ROLE :"proprio";
REVOKE ALL ON DATABASE :"base" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"base" TO :"app", :"lecture", provisionneur;
RESET ROLE;

\connect :base
SET ROLE :"proprio";
-- Le schéma public appartient au propriétaire de la base ; fermé à PUBLIC, ouvert aux deux rôles de connexion.
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO :"app", :"lecture";
ALTER DEFAULT PRIVILEGES FOR ROLE :"proprio" IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO :"app";
ALTER DEFAULT PRIVILEGES FOR ROLE :"proprio" IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO :"app";
ALTER DEFAULT PRIVILEGES FOR ROLE :"proprio" IN SCHEMA public GRANT SELECT ON TABLES TO :"lecture";
ALTER DEFAULT PRIVILEGES FOR ROLE :"proprio" REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
RESET ROLE;

\connect postgres
SET ROLE :"proprio";
REVOKE CONNECT ON DATABASE :"base" FROM provisionneur;
RESET ROLE;
REVOKE :"proprio" FROM CURRENT_USER;
\endif
