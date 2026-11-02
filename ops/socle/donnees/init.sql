-- Grappe « données » (T2-31, ADR 0046) : exécuté une seule fois à l'initialisation, en superutilisateur (seul moment où il sert).
-- Les règles d'accès (pg_hba) sont écrites en dernier ; elles ne valent qu'au démarrage du vrai serveur, après l'initialisation.
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

-- Retrait des droits du provisionneur sur un client (ADR 0046). En PostgreSQL 16, le rôle qui crée un rôle en garde l'option d'administration,
-- accordée par le superutilisateur : le provisionneur ne peut pas la retirer lui-même. Cette fonction, propriété du superutilisateur, le fait pour lui,
-- et seulement pour les trois rôles et la base d'UN client. Elle ne donne rien : elle ne fait que retirer.
CREATE SCHEMA provisionnement;
REVOKE ALL ON SCHEMA provisionnement FROM PUBLIC;
GRANT USAGE ON SCHEMA provisionnement TO provisionneur;
CREATE FUNCTION provisionnement.fermer_client(p_id text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  r record;
BEGIN
  IF p_id IS NULL OR p_id !~ '^[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'fermer_client : id invalide (12 caractères hexadécimaux attendus)';
  END IF;
  FOR r IN
    SELECT ro.rolname AS role, g.rolname AS grantor
    FROM pg_catalog.pg_auth_members m
    JOIN pg_catalog.pg_roles ro ON ro.oid = m.roleid
    JOIN pg_catalog.pg_roles me ON me.oid = m.member
    JOIN pg_catalog.pg_roles g ON g.oid = m.grantor
    WHERE me.rolname = 'provisionneur' AND ro.rolname IN ('cli_' || p_id || '_proprietaire', 'cli_' || p_id || '_app', 'cli_' || p_id || '_lecture')
  LOOP
    EXECUTE pg_catalog.format('REVOKE %I FROM provisionneur GRANTED BY %I CASCADE', r.role, r.grantor);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_database WHERE datname = 'cli_' || p_id) THEN
    EXECUTE pg_catalog.format('REVOKE CONNECT ON DATABASE %I FROM provisionneur', 'cli_' || p_id);
  END IF;
END $$;
REVOKE ALL ON FUNCTION provisionnement.fermer_client(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION provisionnement.fermer_client(text) TO provisionneur;

-- Règles d'accès (pg_hba), remplacées pour le démarrage du vrai serveur. Aucune règle « trust », aucune connexion sans mot de passe.
--  · les rôles des clients n'entrent QUE par la socket partagée avec PgBouncer (volume donnees-socket, monté dans ce seul service et dans pgbouncer-donnees) : jamais en TCP ;
--  · postgres : socket et boucle locale ; provisionneur : socket seulement (le provisionnement T2-34 ajoutera sa règle réseau) ; pgbouncer_auth : socket, base postgres seulement ;
--  · un rôle de migration de module (cli_<12 hex>_mod_<code>, NOLOGIN sauf pendant une migration de T2-35) : socket seulement, une seule règle ; la base est bornée par le droit CONNECT que seul le provisionneur lui donne sur la base de son client (pas de virgule dans un jeton pg_hba : elle sépare les éléments d'une liste, d'où « * » et non « {1,30} », la longueur du code étant contrôlée côté TypeScript) ;
--  · tout le reste est refusé.
SELECT current_setting('hba_file') AS hba \gset
COPY (SELECT unnest(ARRAY[
  'local all postgres scram-sha-256',
  'local postgres pgbouncer_auth scram-sha-256',
  'local all provisionneur scram-sha-256',
  'local all /^cli_[0-9a-f]{12}_(app|lecture)$ scram-sha-256',
  'local all /^cli_[0-9a-f]{12}_mod_[a-z][a-z0-9_]*$ scram-sha-256',
  'local all all reject',
  'host all postgres 127.0.0.1/32 scram-sha-256',
  'host all postgres ::1/128 scram-sha-256',
  'host all all all reject'
])) TO :'hba';
