-- Rôles de connexion : un jeu par base. Un mot de passe PAR RÔLE : empreinte SHA-256 du secret du socle et du nom du rôle.
-- Le secret est lu dans l'environnement (jamais écrit ici) ; le même calcul sert à PgBouncer et aux tests. Le secret lui-même n'ouvre rien.
-- La migration ne reçoit aucun droit par héritage (NOINHERIT) : elle n'agit qu'après SET ROLE vers le propriétaire, posé par défaut à la connexion.
\getenv secret SOCLE_PG_MOT_DE_PASSE

\set ON_ERROR_STOP on
SELECT format('CREATE ROLE %1$I_migration LOGIN NOBYPASSRLS NOINHERIT PASSWORD %2$L IN ROLE %1$I_proprietaire', b, encode(sha256(convert_to(:'secret' || '/' || b || '_migration', 'utf8')), 'hex')),
       format('ALTER ROLE %1$I_migration SET role = %1$I_proprietaire', b),
       format('CREATE ROLE %1$I_app LOGIN NOBYPASSRLS NOINHERIT PASSWORD %2$L', b, encode(sha256(convert_to(:'secret' || '/' || b || '_app', 'utf8')), 'hex')),
       format('CREATE ROLE %1$I_equipe LOGIN NOBYPASSRLS NOINHERIT PASSWORD %2$L', b, encode(sha256(convert_to(:'secret' || '/' || b || '_equipe', 'utf8')), 'hex')),
       format('GRANT CONNECT ON DATABASE %1$I TO %1$I_migration, %1$I_app, %1$I_equipe', b),
       format('ALTER ROLE %1$I_app SET search_path = public', b),
       format('ALTER ROLE %1$I_equipe SET search_path = public', b)
FROM unnest(ARRAY['console', 'moteur']) AS b
\gexec
