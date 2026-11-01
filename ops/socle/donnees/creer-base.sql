-- Recette de création d'une base client (T2-31, ADR 0046), jouée par le provisionneur, en connexion DIRECTE (jamais par PgBouncer) :
--   psql -U provisionneur -d postgres -v id=<12 premiers caractères hexadécimaux de l'UUID> -f creer-base.sql
-- avec dans l'environnement CLI_EMPREINTE_APP et CLI_EMPREINTE_LECTURE : des empreintes SCRAM-SHA-256 calculées par le provisionnement (jamais un mot de passe en clair :
-- un ordre en échec est écrit en entier dans le journal du serveur). Rien de secret n'est écrit ici.
-- CREATE DATABASE ne peut pas tourner dans une transaction : ce n'est pas une fonction, mais une suite d'ordres envoyés hors transaction (T2-34 les envoie).
-- Sans « id » (cas de l'initialisation de la grappe, qui joue tous les scripts du dossier) le script ne fait rien.
-- Arrêt en route : le provisionneur garde alors un accès au client entre la création des rôles et la dernière ligne. Le provisionnement doit rejouer
--   psql … -v id=<id> -v nettoyer=1 -f creer-base.sql
-- qui lui retire tout droit sur ce client (ne détruit rien) ; ce mode est aussi sans danger après une réussite.
\if :{?id}
\set ON_ERROR_STOP on
SELECT :'id' ~ '^[0-9a-f]{12}$' AS id_valide \gset
\if :id_valide
\else
  DO $$ BEGIN RAISE EXCEPTION 'creer-base : id invalide (12 caractères hexadécimaux attendus)'; END $$;
\endif

\if :{?nettoyer}
  SELECT provisionnement.fermer_client(:'id');
  \quit
\endif

-- Valeurs d'essai, petites ; celles de la production sont à définir au lot 8a. Chacune se remplace par -v.
-- limite_app doit rester au moins égale au pool_size du palier de PgBouncer (2, 4 ou 8) : sinon le palier est plafonné sans bruit.
\if :{?modele} \else \set modele modele_v1 \endif
\if :{?delai} \else \set delai 5s \endif
\if :{?memoire} \else \set memoire 4MB \endif
\if :{?limite_app} \else \set limite_app 4 \endif
\if :{?limite_lecture} \else \set limite_lecture 2 \endif
\set emp_app ''
\set emp_lecture ''
\getenv emp_app CLI_EMPREINTE_APP
\getenv emp_lecture CLI_EMPREINTE_LECTURE

-- Toute valeur collée dans un ordre SQL est contrôlée ici, avant le moindre changement.
SELECT :'modele' ~ '^modele_v[0-9]+$' AND :'delai' ~ '^[0-9]+(ms|s|min)$' AND :'memoire' ~ '^[0-9]+(kB|MB|GB)$'
  AND :'limite_app' ~ '^[0-9]{1,4}$' AND :'limite_lecture' ~ '^[0-9]{1,4}$' AS options_valides \gset
\if :options_valides
\else
  DO $$ BEGIN RAISE EXCEPTION 'creer-base : option invalide (modele, delai, memoire, limite_app ou limite_lecture)'; END $$;
\endif
SELECT :'emp_app' ~ '^SCRAM-SHA-256\$[0-9]+:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$' AND :'emp_lecture' ~ '^SCRAM-SHA-256\$[0-9]+:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$' AS empreintes_valides \gset
\if :empreintes_valides
\else
  DO $$ BEGIN RAISE EXCEPTION 'creer-base : CLI_EMPREINTE_APP et CLI_EMPREINTE_LECTURE doivent être des empreintes SCRAM-SHA-256 (jamais un mot de passe en clair)'; END $$;
\endif

SELECT 'cli_' || :'id' AS base, 'cli_' || :'id' || '_proprietaire' AS proprio, 'cli_' || :'id' || '_app' AS app, 'cli_' || :'id' || '_lecture' AS lecture \gset
-- Rien n'existe encore pour ce client, et le modèle est bien un modèle : sinon on s'arrête avant d'avoir changé quoi que ce soit.
SELECT NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'base')
  AND NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname IN (:'proprio', :'app', :'lecture'))
  AND EXISTS (SELECT 1 FROM pg_database WHERE datname = :'modele' AND datistemplate) AS pret \gset
\if :pret
\else
  DO $$ BEGIN RAISE EXCEPTION 'creer-base : base ou rôles déjà présents pour cet id, ou modèle absent'; END $$;
\endif

-- Les trois rôles. Le propriétaire ne se connecte pas ; l'application ne possède rien ; la lecture ne fait que lire.
CREATE ROLE :"proprio" NOLOGIN NOBYPASSRLS;
CREATE ROLE :"app" LOGIN NOBYPASSRLS NOINHERIT CONNECTION LIMIT :limite_app PASSWORD :'emp_app';
CREATE ROLE :"lecture" LOGIN NOBYPASSRLS NOINHERIT CONNECTION LIMIT :limite_lecture PASSWORD :'emp_lecture';
-- Limites par rôle (A-417) : une requête trop longue est coupée, la mémoire de travail est bornée.
-- Le client peut les changer lui-même par SET : la limite qu'il ne peut pas lever est celle de PgBouncer (query_timeout, idle_transaction_timeout), voir l'ADR.
ALTER ROLE :"app" SET statement_timeout = :'delai';
ALTER ROLE :"app" SET work_mem = :'memoire';
ALTER ROLE :"lecture" SET statement_timeout = :'delai';
ALTER ROLE :"lecture" SET work_mem = :'memoire';

-- Le provisionneur n'agit en propriétaire que le temps de la recette ; provisionnement.fermer_client lui retire tout à la fin (ou par -v nettoyer=1 après un arrêt).
GRANT :"proprio" TO CURRENT_USER WITH SET TRUE;
CREATE DATABASE :"base" TEMPLATE :"modele" OWNER :"proprio";
SET ROLE :"proprio";
REVOKE ALL ON DATABASE :"base" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"base" TO :"app", :"lecture", provisionneur;
RESET ROLE;

\connect :base
SET ROLE :"proprio";
-- Le schéma public appartient au propriétaire ; fermé à PUBLIC, ouvert aux deux rôles de connexion.
ALTER SCHEMA public OWNER TO :"proprio";
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO :"app", :"lecture";
ALTER DEFAULT PRIVILEGES FOR ROLE :"proprio" IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO :"app";
ALTER DEFAULT PRIVILEGES FOR ROLE :"proprio" IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO :"app";
ALTER DEFAULT PRIVILEGES FOR ROLE :"proprio" IN SCHEMA public GRANT SELECT ON TABLES TO :"lecture";
ALTER DEFAULT PRIVILEGES FOR ROLE :"proprio" REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
RESET ROLE;

\connect postgres
SELECT provisionnement.fermer_client(:'id');
\endif
