-- Journal d'audit : RLS, droits, fonctions et déclencheurs (ADR 0042). Écrit à la main (drizzle-kit generate --custom).
ALTER TABLE "public"."journal_audit" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."journal_audit" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY isolation_client ON "public"."journal_audit" FOR SELECT TO console_app USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY lecture_equipe ON "public"."journal_audit" FOR SELECT TO console_equipe USING (tenant_id IS NULL OR tenant_id IS NOT NULL);--> statement-breakpoint
CREATE POLICY ecriture_proprietaire ON "public"."journal_audit" FOR INSERT TO console_proprietaire WITH CHECK (tenant_id IS NULL OR tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY lecture_proprietaire ON "public"."journal_audit" FOR SELECT TO console_proprietaire USING (tenant_id IS NULL OR tenant_id IS NOT NULL);--> statement-breakpoint
REVOKE ALL ON TABLE "public"."journal_audit" FROM PUBLIC;--> statement-breakpoint
GRANT SELECT ON TABLE "public"."journal_audit" TO console_app, console_equipe;--> statement-breakpoint
CREATE FUNCTION public.audit_contenu(p_id bigint, p_tenant uuid, p_acteur text, p_action public.action_audit, p_entite text, p_entite_id text, p_ancienne jsonb, p_nouvelle jsonb, p_ip inet, p_cree timestamptz)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $fonction$
  SELECT jsonb_build_array(p_id, p_tenant, p_acteur, p_action::text, p_entite, p_entite_id, p_ancienne, p_nouvelle, host(p_ip), to_char(p_cree AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))::text
$fonction$;--> statement-breakpoint
CREATE FUNCTION public.audit_inserer(p_tenant uuid, p_acteur text, p_action public.action_audit, p_entite text, p_entite_id text, p_ancienne jsonb, p_nouvelle jsonb, p_ip inet)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fonction$
DECLARE
  v_id bigint;
  v_cree timestamptz := clock_timestamp();
  v_precedente text;
  v_empreinte text;
BEGIN
  -- Une seule écriture à la fois dans la chaîne : le verrou tient jusqu'à la fin de la transaction, la lecture de la dernière empreinte vient après lui.
  PERFORM pg_advisory_xact_lock(7410020241028);
  SELECT j.empreinte INTO v_precedente FROM public.journal_audit j ORDER BY j.id DESC LIMIT 1;
  v_id := nextval(pg_get_serial_sequence('public.journal_audit', 'id')::regclass);
  v_empreinte := encode(sha256(convert_to(coalesce(v_precedente, '') || public.audit_contenu(v_id, p_tenant, p_acteur, p_action, p_entite, p_entite_id, p_ancienne, p_nouvelle, p_ip, v_cree), 'UTF8')), 'hex');
  INSERT INTO public.journal_audit (id, tenant_id, acteur, action, entite, entite_id, ancienne, nouvelle, ip, cree_le, empreinte_precedente, empreinte)
  OVERRIDING SYSTEM VALUE
  VALUES (v_id, p_tenant, p_acteur, p_action, p_entite, p_entite_id, p_ancienne, p_nouvelle, p_ip, v_cree, v_precedente, v_empreinte);
  RETURN v_id;
END
$fonction$;--> statement-breakpoint
CREATE FUNCTION public.audit_ajouter(p_tenant uuid, p_acteur text, p_action public.action_audit, p_entite text, p_entite_id text, p_ancienne jsonb, p_nouvelle jsonb)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fonction$
BEGIN
  -- Le client de la ligne est celui de la transaction : une écriture pour un autre client, ou pour l'équipe depuis un client actif, est refusée.
  IF p_tenant IS DISTINCT FROM NULLIF(current_setting('app.tenant_id', true), '')::uuid THEN
    RAISE EXCEPTION 'audit_ajouter : la ligne ne porte pas le client actif';
  END IF;
  IF p_acteur IS NULL OR btrim(p_acteur) = '' OR length(p_acteur) > 128 THEN
    RAISE EXCEPTION 'audit_ajouter : acteur invalide';
  END IF;
  RETURN public.audit_inserer(p_tenant, p_acteur, p_action, p_entite, p_entite_id, p_ancienne, p_nouvelle, NULLIF(current_setting('app.ip', true), '')::inet);
END
$fonction$;--> statement-breakpoint
CREATE FUNCTION public.audit_ecrire()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $fonction$
DECLARE
  v_ancienne jsonb;
  v_nouvelle jsonb;
  v_ligne jsonb;
BEGIN
  -- Déclencheur AFTER ligne des tables de client : sans SECURITY DEFINER, il appelle audit_ajouter (ouverte à console_app) avec l'acteur de la transaction.
  IF TG_OP = 'INSERT' THEN
    v_nouvelle := to_jsonb(NEW);
  ELSIF TG_OP = 'UPDATE' THEN
    v_ancienne := to_jsonb(OLD);
    v_nouvelle := to_jsonb(NEW);
  ELSE
    v_ancienne := to_jsonb(OLD);
  END IF;
  v_ligne := coalesce(v_nouvelle, v_ancienne);
  PERFORM public.audit_ajouter(
    (v_ligne ->> 'tenant_id')::uuid,
    coalesce(NULLIF(current_setting('app.acteur', true), ''), 'systeme'),
    (CASE TG_OP WHEN 'INSERT' THEN 'insertion' WHEN 'UPDATE' THEN 'modification' ELSE 'suppression' END)::public.action_audit,
    TG_TABLE_NAME::text,
    coalesce(v_ligne ->> 'id', v_ligne ->> 'tenant_id'),
    v_ancienne,
    v_nouvelle);
  RETURN NULL;
END
$fonction$;--> statement-breakpoint
CREATE FUNCTION public.audit_refuser()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $fonction$
BEGIN
  RAISE EXCEPTION 'journal_audit : ajout seul, aucune modification, suppression ni vidage' USING ERRCODE = 'insufficient_privilege';
END
$fonction$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.audit_contenu(bigint, uuid, text, public.action_audit, text, text, jsonb, jsonb, inet, timestamptz) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.audit_inserer(uuid, text, public.action_audit, text, text, jsonb, jsonb, inet) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.audit_ajouter(uuid, text, public.action_audit, text, text, jsonb, jsonb) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.audit_ecrire() FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.audit_refuser() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.audit_ajouter(uuid, text, public.action_audit, text, text, jsonb, jsonb) TO console_app;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.audit_contenu(bigint, uuid, text, public.action_audit, text, text, jsonb, jsonb, inet, timestamptz) TO console_equipe;--> statement-breakpoint
CREATE TRIGGER journal_audit_refuser_ligne BEFORE UPDATE OR DELETE ON "public"."journal_audit" FOR EACH ROW EXECUTE FUNCTION public.audit_refuser();--> statement-breakpoint
CREATE TRIGGER journal_audit_refuser_vidage BEFORE TRUNCATE ON "public"."journal_audit" FOR EACH STATEMENT EXECUTE FUNCTION public.audit_refuser();
