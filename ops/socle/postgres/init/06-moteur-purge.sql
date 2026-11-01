-- Rôle de purge de l'état technique (C-415) : il se connecte à la base moteur et à nulle autre (aucun CONNECT ailleurs, PUBLIC est déjà fermé par 01-bases.sql).
-- Même calcul de mot de passe que 02-roles.sql : empreinte SHA-256 du secret du socle et du nom du rôle. Le droit sur les tables est donné par la migration moteur 0000.
\getenv secret SOCLE_PG_MOT_DE_PASSE

\set ON_ERROR_STOP on
SELECT format('CREATE ROLE moteur_purge LOGIN NOBYPASSRLS NOINHERIT PASSWORD %L', encode(sha256(convert_to(:'secret' || '/moteur_purge', 'utf8')), 'hex')) \gexec
GRANT CONNECT ON DATABASE moteur TO moteur_purge;
\connect moteur
GRANT USAGE ON SCHEMA public TO moteur_purge;
ALTER ROLE moteur_purge SET search_path = public;
