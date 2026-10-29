-- Journal d'audit : réserves de l'audit de sécurité de la PR 94 (ADR 0042, « Réserves »). Écrit à la main (drizzle-kit generate --custom).
-- 0001 est déjà appliquée : on ne la modifie pas, on remplace les trois fonctions (CREATE OR REPLACE garde leurs droits).
CREATE OR REPLACE FUNCTION public.audit_contenu(p_id bigint, p_tenant uuid, p_acteur text, p_action public.action_audit, p_entite text, p_entite_id text, p_ancienne jsonb, p_nouvelle jsonb, p_ip inet, p_cree timestamptz)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $fonction$
  -- abbrev(p_ip) garde le masque d'un réseau (host() le perdait) et écrit une adresse d'hôte comme avant, sans /32 ni /128 :
  -- p_ip::text écrirait toujours le masque et casserait la vérification de chaque ligne déjà chaînée (ADR 0042).
  SELECT jsonb_build_array(p_id, p_tenant, p_acteur, p_action::text, p_entite, p_entite_id, p_ancienne, p_nouvelle, abbrev(p_ip), to_char(p_cree AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))::text
$fonction$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.audit_inserer(p_tenant uuid, p_acteur text, p_action public.action_audit, p_entite text, p_entite_id text, p_ancienne jsonb, p_nouvelle jsonb, p_ip inet)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $fonction$
DECLARE
  v_id bigint;
  v_cree timestamptz := clock_timestamp();
  v_precedente text;
  v_empreinte text;
  v_inactif interval;
BEGIN
  -- En REPEATABLE READ ou SERIALIZABLE, la photo des données est prise avant le verrou : deux écritures verraient la même dernière empreinte et la chaîne fourcherait.
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'audit_inserer : niveau d''isolation de la transaction refusé (READ COMMITTED exigé)';
  END IF;
  -- Une seule écriture à la fois dans la chaîne. Le verrou de table, tenu jusqu'à la fin de la transaction, n'est pas à la portée de console_app
  -- (il demande un droit d'écriture sur la table) ; la lecture de la dernière empreinte vient après lui, avec une photo neuve.
  LOCK TABLE public.journal_audit IN SHARE ROW EXCLUSIVE MODE;
  -- Le verrou bloque toutes les écritures auditées : la transaction qui le tient ne reste pas inactive plus de 5 s, sinon PostgreSQL coupe sa session
  -- (et rend le verrou). SET LOCAL hors des clauses SET de la fonction : le réglage vaut jusqu'à la fin de la transaction. Un réglage plus strict est gardé.
  v_inactif := current_setting('idle_in_transaction_session_timeout')::interval;
  IF v_inactif = interval '0' OR v_inactif > interval '5 seconds' THEN
    SET LOCAL idle_in_transaction_session_timeout = '5s';
  END IF;
  SELECT j.empreinte INTO v_precedente FROM public.journal_audit j ORDER BY j.id DESC LIMIT 1;
  v_id := nextval(pg_get_serial_sequence('public.journal_audit', 'id')::regclass);
  v_empreinte := encode(sha256(convert_to(coalesce(v_precedente, '') || public.audit_contenu(v_id, p_tenant, p_acteur, p_action, p_entite, p_entite_id, p_ancienne, p_nouvelle, p_ip, v_cree), 'UTF8')), 'hex');
  INSERT INTO public.journal_audit (id, tenant_id, acteur, action, entite, entite_id, ancienne, nouvelle, ip, cree_le, empreinte_precedente, empreinte)
  OVERRIDING SYSTEM VALUE
  VALUES (v_id, p_tenant, p_acteur, p_action, p_entite, p_entite_id, p_ancienne, p_nouvelle, p_ip, v_cree, v_precedente, v_empreinte);
  RETURN v_id;
END
$fonction$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.audit_ajouter(p_tenant uuid, p_acteur text, p_action public.action_audit, p_entite text, p_entite_id text, p_ancienne jsonb, p_nouvelle jsonb)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fonction$
DECLARE
  v_ip inet;
BEGIN
  -- Le client de la ligne est celui de la transaction : une écriture pour un autre client, ou pour l'équipe depuis un client actif, est refusée.
  IF p_tenant IS DISTINCT FROM NULLIF(current_setting('app.tenant_id', true), '')::uuid THEN
    RAISE EXCEPTION 'audit_ajouter : la ligne ne porte pas le client actif';
  END IF;
  -- Bornes de ce qu'un console_app peut écrire en appelant la fonction lui-même (la chaîne garantit l'intégrité, pas l'authenticité : ADR 0042).
  IF p_acteur IS NULL OR btrim(p_acteur) = '' OR length(p_acteur) > 128 OR p_acteur ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'audit_ajouter : acteur invalide';
  END IF;
  IF p_entite IS NULL OR p_entite !~ '^[a-z_][a-z0-9_]{0,62}$' THEN
    RAISE EXCEPTION 'audit_ajouter : entité invalide';
  END IF;
  IF p_entite_id IS NOT NULL AND (btrim(p_entite_id) = '' OR length(p_entite_id) > 128 OR p_entite_id ~ '[[:cntrl:]]') THEN
    RAISE EXCEPTION 'audit_ajouter : identifiant d''entité invalide';
  END IF;
  IF octet_length(p_ancienne::text) > 262144 OR octet_length(p_nouvelle::text) > 262144 THEN
    RAISE EXCEPTION 'audit_ajouter : valeur de plus de 256 Kio';
  END IF;
  v_ip := NULLIF(current_setting('app.ip', true), '')::inet;
  IF v_ip IS NOT NULL AND masklen(v_ip) <> (CASE family(v_ip) WHEN 4 THEN 32 ELSE 128 END) THEN
    RAISE EXCEPTION 'audit_ajouter : adresse IP invalide (adresse d''hôte attendue)';
  END IF;
  RETURN public.audit_inserer(p_tenant, p_acteur, p_action, p_entite, p_entite_id, p_ancienne, p_nouvelle, v_ip);
END
$fonction$;
