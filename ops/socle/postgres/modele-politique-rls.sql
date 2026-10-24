-- Modèle de politique d'isolation par client (C5) que le lot 2 applique à CHAQUE table métier, dans la migration qui la crée.
-- La table existe déjà avec tenant_id uuid NOT NULL (colonne d'identité : GENERATED ALWAYS AS IDENTITY, pas de serial).
-- Paramètres, fixés dans la même transaction : SELECT set_config('modele.schema', 'public', true), set_config('modele.table', 'dossiers', true),
--   set_config('modele.app', 'console_app', true), set_config('modele.equipe', 'console_equipe', true);
-- Rejouable : deux applications donnent le même résultat. Toute autre politique de la table (TO PUBLIC, autre rôle, autre nom) est supprimée : seules isolation_client et lecture_equipe restent. Aucun droit n'est accordé hors de ce fichier (pas de droit par défaut).
DO $modele$
DECLARE
  schema_ text := current_setting('modele.schema');
  table_ text := current_setting('modele.table');
  cible text := format('%I.%I', current_setting('modele.schema'), current_setting('modele.table'));
  app text := current_setting('modele.app');
  equipe text := current_setting('modele.equipe');
  autre record;
  client_actif text := $c$tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid$c$;
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', cible);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', cible);
  EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %s (tenant_id)', table_ || '_tenant', cible);
  FOR autre IN SELECT polname FROM pg_policy WHERE polrelid = cible::regclass AND polname NOT IN ('isolation_client', 'lecture_equipe') LOOP
    EXECUTE format('DROP POLICY %I ON %s', autre.polname, cible);
  END LOOP;
  EXECUTE format('DROP POLICY IF EXISTS isolation_client ON %s', cible);
  EXECUTE format('CREATE POLICY isolation_client ON %s FOR ALL TO %I USING (%s) WITH CHECK (%s)', cible, app, client_actif, client_actif);
  -- L'équipe lit tous les clients : « tenant_id IS NOT NULL » vaut « vrai » (colonne NOT NULL) et cite tenant_id, comme l'exige l'invariant C5 (USING (true) est signalé).
  EXECUTE format('DROP POLICY IF EXISTS lecture_equipe ON %s', cible);
  EXECUTE format('CREATE POLICY lecture_equipe ON %s FOR SELECT TO %I USING (tenant_id IS NOT NULL)', cible, equipe);
  EXECUTE format('GRANT USAGE ON SCHEMA %I TO %I, %I', schema_, app, equipe);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %s TO %I', cible, app);
  EXECUTE format('GRANT SELECT ON %s TO %I', cible, equipe);
END
$modele$;
