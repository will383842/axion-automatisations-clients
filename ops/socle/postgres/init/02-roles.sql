-- Rôles de connexion : un jeu par base. Un mot de passe par rôle, calculé ici et dans PgBouncer : sha256("<secret du socle>/<rôle>") en hexadécimal.
-- Le secret de test vient de l'environnement (jamais écrit ici) et n'ouvre aucun rôle par lui-même, le superutilisateur compris.
\getenv secret SOCLE_PG_MOT_DE_PASSE
\set ON_ERROR_STOP on
SELECT set_config('socle.secret', :'secret', false) AS fixe
\gset
CREATE FUNCTION pg_temp.mdp(text) RETURNS text LANGUAGE sql AS $$ SELECT encode(sha256(convert_to(current_setting('socle.secret') || '/' || $1, 'UTF8')), 'hex') $$;
SELECT format('ALTER ROLE postgres PASSWORD %L', pg_temp.mdp('postgres'))
\gexec
-- La migration ne reçoit aucun droit du propriétaire par héritage : elle prend son rôle (SET ROLE) à la connexion, rien de plus.
SELECT format('CREATE ROLE %1$I_migration LOGIN NOBYPASSRLS NOINHERIT PASSWORD %2$L', b, pg_temp.mdp(b || '_migration')),
       format('GRANT %1$I_proprietaire TO %1$I_migration WITH INHERIT FALSE, SET TRUE', b),
       format('ALTER ROLE %1$I_migration SET role = %1$I_proprietaire', b),
       format('CREATE ROLE %1$I_app LOGIN NOBYPASSRLS NOINHERIT PASSWORD %2$L', b, pg_temp.mdp(b || '_app')),
       format('CREATE ROLE %1$I_equipe LOGIN NOBYPASSRLS NOINHERIT PASSWORD %2$L', b, pg_temp.mdp(b || '_equipe')),
       format('GRANT CONNECT ON DATABASE %1$I TO %1$I_migration, %1$I_app, %1$I_equipe', b),
       format('ALTER ROLE %1$I_app SET search_path = public', b),
       format('ALTER ROLE %1$I_equipe SET search_path = public', b)
FROM unnest(ARRAY['console', 'moteur']) AS b
\gexec
