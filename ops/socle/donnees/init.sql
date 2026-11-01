-- Grappe « données » (T2-31, ADR 0046) : exécuté une seule fois à l'initialisation, en superutilisateur (seul moment où il sert).
-- Aucune base ne s'ouvre à PUBLIC, pas même les bases système ni le modèle : une base créée depuis elles n'hérite d'aucun droit de connexion.
-- Mots de passe : SHA-256 du secret de test et du nom du rôle (le secret est lu dans l'environnement, jamais écrit ici).
\getenv secret SOCLE_PG_MOT_DE_PASSE
\set ON_ERROR_STOP on

CREATE DATABASE modele_v1 IS_TEMPLATE true;
REVOKE ALL ON DATABASE postgres, template0, template1, modele_v1 FROM PUBLIC;

-- Le provisionneur crée les bases et les rôles des clients : ni superutilisateur, ni BYPASSRLS, aucun droit sur les données.
SELECT format('CREATE ROLE provisionneur LOGIN CREATEDB CREATEROLE NOSUPERUSER NOBYPASSRLS NOINHERIT PASSWORD %L', encode(sha256(convert_to(:'secret' || '/provisionneur', 'utf8')), 'hex'))
\gexec
GRANT CONNECT ON DATABASE postgres TO provisionneur;
-- Il garde une place quand les 250 connexions des clients sont prises.
GRANT pg_use_reserved_connections TO provisionneur WITH INHERIT TRUE;

-- Le seul rôle que PgBouncer ouvre lui-même : il lit les mots de passe des rôles cli_…_app et cli_…_lecture, rien d'autre.
SELECT format('CREATE ROLE pgbouncer_auth LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT PASSWORD %L', encode(sha256(convert_to(:'secret' || '/pgbouncer_auth', 'utf8')), 'hex'))
\gexec
GRANT CONNECT ON DATABASE postgres TO pgbouncer_auth;
CREATE SCHEMA pgbouncer;
REVOKE ALL ON SCHEMA pgbouncer FROM PUBLIC;
GRANT USAGE ON SCHEMA pgbouncer TO pgbouncer_auth;
CREATE FUNCTION pgbouncer.chercher_utilisateur(p_nom text) RETURNS TABLE (usename name, passwd text)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT s.usename, s.passwd FROM pg_catalog.pg_shadow s WHERE s.usename = p_nom AND s.usename ~ '^cli_[0-9a-f]{12}_(app|lecture)$'
$$;
REVOKE ALL ON FUNCTION pgbouncer.chercher_utilisateur(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pgbouncer.chercher_utilisateur(text) TO pgbouncer_auth;
