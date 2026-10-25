-- Les quatre bases de la grappe commune (A-186). Les bases cli_<id> vivent dans l'autre grappe (lot 2b).
-- Exécuté une seule fois par l'entrée de l'image, en superutilisateur : seul moment où il sert.
CREATE ROLE console_proprietaire NOLOGIN;
CREATE ROLE moteur_proprietaire NOLOGIN;
CREATE DATABASE console OWNER console_proprietaire;
CREATE DATABASE moteur OWNER moteur_proprietaire;
CREATE DATABASE keycloak;
CREATE DATABASE passerelle_ia;

-- Personne n'entre ni ne crée de table temporaire par défaut, pas même dans les bases système.
REVOKE ALL ON DATABASE console, moteur, keycloak, passerelle_ia, postgres, template1 FROM PUBLIC;
