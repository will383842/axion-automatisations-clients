-- Base console : schéma public au propriétaire, fermé à PUBLIC ; pg_partman dans son schéma ; aucun droit par défaut sur les objets à venir.
\connect console
\set ON_ERROR_STOP on
ALTER SCHEMA public OWNER TO console_proprietaire;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO console_app, console_equipe;
CREATE SCHEMA partman AUTHORIZATION console_proprietaire;
CREATE EXTENSION pg_partman SCHEMA partman;
GRANT ALL ON ALL TABLES IN SCHEMA partman TO console_proprietaire;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA partman TO console_proprietaire;
GRANT EXECUTE ON ALL PROCEDURES IN SCHEMA partman TO console_proprietaire;
-- Une fonction créée par la migration n'est exécutable par personne d'autre tant qu'on ne l'accorde pas.
ALTER DEFAULT PRIVILEGES FOR ROLE console_proprietaire REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
-- La migration, hors SET ROLE, n'ouvre pas non plus ses fonctions : même défaut pour ses propres objets.
ALTER DEFAULT PRIVILEGES FOR ROLE console_migration REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
