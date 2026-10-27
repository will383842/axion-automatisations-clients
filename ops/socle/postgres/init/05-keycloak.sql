-- Base keycloak : un rôle de connexion propre, propriétaire de sa base (Keycloak crée ses tables). Connexion directe, jamais par PgBouncer.
-- Même calcul de mot de passe que 02-roles.sql : SHA-256 du secret du socle et du nom du rôle ; le secret est lu dans l'environnement.
\getenv secret SOCLE_PG_MOT_DE_PASSE

\set ON_ERROR_STOP on
SELECT format('CREATE ROLE keycloak_app LOGIN NOBYPASSRLS NOINHERIT PASSWORD %L', encode(sha256(convert_to(:'secret' || '/keycloak_app', 'utf8')), 'hex'))
\gexec
ALTER DATABASE keycloak OWNER TO keycloak_app;
