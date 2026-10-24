-- Base moteur : schéma public au propriétaire, fermé à PUBLIC ; pg_partman dans son schéma ; aucun droit par défaut sur les objets à venir.
\connect moteur
\set ON_ERROR_STOP on
ALTER SCHEMA public OWNER TO moteur_proprietaire;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO moteur_app, moteur_equipe;
CREATE SCHEMA partman AUTHORIZATION moteur_proprietaire;
CREATE EXTENSION pg_partman SCHEMA partman;
GRANT ALL ON ALL TABLES IN SCHEMA partman TO moteur_proprietaire;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA partman TO moteur_proprietaire;
GRANT EXECUTE ON ALL PROCEDURES IN SCHEMA partman TO moteur_proprietaire;
-- Une fonction créée par la migration n'est exécutable par personne d'autre tant qu'on ne l'accorde pas.
ALTER DEFAULT PRIVILEGES FOR ROLE moteur_proprietaire REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
