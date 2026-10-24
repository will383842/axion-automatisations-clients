-- Rôles de connexion : un jeu par base. Mot de passe de test unique, lu dans l'environnement (jamais écrit ici).
\getenv mdp POSTGRES_PASSWORD

\set ON_ERROR_STOP on
SELECT format('CREATE ROLE %1$I_migration LOGIN NOBYPASSRLS PASSWORD %2$L IN ROLE %1$I_proprietaire', b, :'mdp'),
       format('ALTER ROLE %1$I_migration SET role = %1$I_proprietaire', b),
       format('CREATE ROLE %1$I_app LOGIN NOBYPASSRLS NOINHERIT PASSWORD %2$L', b, :'mdp'),
       format('CREATE ROLE %1$I_equipe LOGIN NOBYPASSRLS NOINHERIT PASSWORD %2$L', b, :'mdp'),
       format('GRANT CONNECT ON DATABASE %1$I TO %1$I_migration, %1$I_app, %1$I_equipe', b),
       format('ALTER ROLE %1$I_app SET search_path = public', b),
       format('ALTER ROLE %1$I_equipe SET search_path = public', b)
FROM unnest(ARRAY['console', 'moteur']) AS b
\gexec
