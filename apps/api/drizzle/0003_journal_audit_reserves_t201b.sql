-- Journal d'audit : réserves de l'audit de la PR 95 (ADR 0043 et 0042). Écrit à la main (drizzle-kit generate --custom).
-- Contrôle de l'ADR 0042 (R2), AVANT toute autre instruction : la migration est refusée si une ligne du journal porte une IP avec masque.
-- Pas de bloc DO (la garde des migrations les refuse) : la conversion en entier d'un message d'erreur échoue et affiche ce message.
SELECT (CASE WHEN EXISTS (SELECT 1 FROM public.journal_audit WHERE ip IS NOT NULL AND masklen(ip) <> CASE family(ip) WHEN 4 THEN 32 ELSE 128 END)
  THEN 'migration 0003 refusée : le journal contient une adresse IP avec masque (ADR 0042, R2), décision de l''architecte requise'
  ELSE '0' END)::integer;--> statement-breakpoint
-- audit_ajouter : la classe refusée compte aussi U+180E, U+00AD et U+3164 (écrite en échappements \u pour rester lisible et relue).
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
  -- Refusés : contrôles, caractères invisibles ou d'inversion (U+00AD, U+061C, U+180E, U+200B-200F, U+202A-202E, U+2028, U+2029, U+2060-206F, U+3164, U+FEFF)
  -- et texte fait seulement d'espaces Unicode.
  IF p_acteur IS NULL OR p_acteur ~ '^[[:space:]\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]*$' OR length(p_acteur) > 128
     OR p_acteur ~ '[[:cntrl:]\u00AD\u061C\u180E\u200B-\u200F\u202A-\u202E\u2028\u2029\u2060-\u206F\u3164\uFEFF]' THEN
    RAISE EXCEPTION 'audit_ajouter : acteur invalide';
  END IF;
  IF p_entite IS NULL OR p_entite !~ '^[a-z_][a-z0-9_]{0,62}$' THEN
    RAISE EXCEPTION 'audit_ajouter : entité invalide';
  END IF;
  IF p_entite_id IS NOT NULL AND (p_entite_id ~ '^[[:space:]\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]*$' OR length(p_entite_id) > 128
     OR p_entite_id ~ '[[:cntrl:]\u00AD\u061C\u180E\u200B-\u200F\u202A-\u202E\u2028\u2029\u2060-\u206F\u3164\uFEFF]') THEN
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
$fonction$;--> statement-breakpoint
-- audit_ecrire : la copie de la ligne ne fait jamais échouer l'écriture métier. Au-delà de 256 Kio, les valeurs de plus de 64 Kio sont remplacées
-- par {"_omis": "taille", "octets": n} ; si cela ne suffit pas, toute la copie l'est. La borne de audit_ajouter reste la dernière barrière.
CREATE OR REPLACE FUNCTION public.audit_ecrire()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $fonction$
DECLARE
  v_ancienne jsonb;
  v_nouvelle jsonb;
  v_ligne jsonb;
  v_copie jsonb;
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
  FOR i IN 1..2 LOOP
    v_copie := CASE i WHEN 1 THEN v_ancienne ELSE v_nouvelle END;
    IF octet_length(v_copie::text) > 262144 THEN
      SELECT jsonb_object_agg(e.key, CASE WHEN octet_length(e.value::text) > 65536 THEN jsonb_build_object('_omis', 'taille', 'octets', octet_length(e.value::text)) ELSE e.value END)
        INTO v_copie FROM jsonb_each(v_copie) e;
      IF octet_length(v_copie::text) > 262144 THEN
        v_copie := jsonb_build_object('_omis', 'taille');
      END IF;
    END IF;
    IF i = 1 THEN v_ancienne := v_copie; ELSE v_nouvelle := v_copie; END IF;
  END LOOP;
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
$fonction$;
