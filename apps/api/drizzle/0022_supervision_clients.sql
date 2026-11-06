-- T5-01a (ADR 0116) : tables de la supervision par client. ADDITIVE : aucun DROP, DELETE, TRUNCATE, RENAME ni changement de type. Numéro 0022 (prochain libre après 0021).
-- mesures_bases est partitionnée par mois sur "debut" (drizzle-kit ne génère pas PARTITION BY ; partie écrite à la main, comme 0010).
CREATE TYPE "public"."etape_suspension" AS ENUM('avertissement', 'limitation', 'suspension');--> statement-breakpoint
CREATE TYPE "public"."etat_rapport" AS ENUM('prepare', 'envoye');--> statement-breakpoint
CREATE TYPE "public"."etat_sante" AS ENUM('saine', 'degradee', 'en_panne', 'inconnue');--> statement-breakpoint
CREATE TYPE "public"."motif_suspension" AS ENUM('envois_excessifs', 'plaintes', 'usage_interdit', 'autre');--> statement-breakpoint
CREATE TABLE "liens_retour" (
	"tenant_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"organisation_id" uuid NOT NULL,
	"adresse" text NOT NULL,
	"verifiee" boolean DEFAULT false NOT NULL,
	"dernier_controle_le" timestamp with time zone,
	"attributs_trouves" text[] DEFAULT '{}' NOT NULL,
	CONSTRAINT "liens_retour_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "liens_retour_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "liens_retour_adresse_unique" UNIQUE("tenant_id","organisation_id","adresse"),
	CONSTRAINT "liens_retour_adresse_forme" CHECK ("liens_retour"."adresse" ~ '^https://[A-Za-z0-9.-]{1,253}(/[A-Za-z0-9._~/%-]{0,500})?$' AND char_length("liens_retour"."adresse") <= 800),
	CONSTRAINT "liens_retour_attributs_bornes" CHECK (cardinality("liens_retour"."attributs_trouves") <= 32)
);
--> statement-breakpoint
CREATE TABLE "mesures_bases" (
	"tenant_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"debut" timestamp with time zone NOT NULL,
	"base" text NOT NULL,
	"taille_octets" bigint NOT NULL,
	"quota_octets" bigint,
	"connexions" integer NOT NULL,
	"requetes_lentes" integer NOT NULL,
	"lignes_mortes" bigint NOT NULL,
	"version_structure" text NOT NULL,
	"age_sauvegarde_s" integer,
	"age_test_restauration_s" integer,
	CONSTRAINT "mesures_bases_tenant_id_id_debut_pk" PRIMARY KEY("tenant_id","id","debut"),
	CONSTRAINT "mesures_bases_base_forme" CHECK ("mesures_bases"."base" ~ '^cli_[a-z0-9_]{1,59}$'),
	CONSTRAINT "mesures_bases_version_code" CHECK ("mesures_bases"."version_structure" ~ '^[a-z0-9][a-z0-9_.-]{0,31}$'),
	CONSTRAINT "mesures_bases_valeurs_positives" CHECK ("mesures_bases"."taille_octets" >= 0 AND ("mesures_bases"."quota_octets" IS NULL OR "mesures_bases"."quota_octets" > 0) AND "mesures_bases"."connexions" >= 0 AND "mesures_bases"."requetes_lentes" >= 0 AND "mesures_bases"."lignes_mortes" >= 0 AND coalesce("mesures_bases"."age_sauvegarde_s", 0) >= 0 AND coalesce("mesures_bases"."age_test_restauration_s", 0) >= 0)
) PARTITION BY RANGE ("debut");
--> statement-breakpoint
CREATE TABLE "rapports_mensuels" (
	"tenant_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"organisation_id" uuid NOT NULL,
	"mois" date NOT NULL,
	"objet_pdf_ref" text NOT NULL,
	"etat" "etat_rapport" DEFAULT 'prepare' NOT NULL,
	"envoye_par" text,
	"envoye_le" timestamp with time zone,
	CONSTRAINT "rapports_mensuels_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "rapports_mensuels_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "rapports_mensuels_mois_unique" UNIQUE("tenant_id","organisation_id","mois"),
	CONSTRAINT "rapports_mensuels_premier_du_mois" CHECK (extract(day from "rapports_mensuels"."mois") = 1),
	CONSTRAINT "rapports_mensuels_objet_forme" CHECK ("rapports_mensuels"."objet_pdf_ref" ~ '^[A-Za-z0-9][A-Za-z0-9_./-]{0,254}$' AND "rapports_mensuels"."objet_pdf_ref" !~ '\.\.'),
	CONSTRAINT "rapports_mensuels_envoi_coherent" CHECK (("rapports_mensuels"."etat" = 'envoye') = ("rapports_mensuels"."envoye_le" IS NOT NULL) AND ("rapports_mensuels"."envoye_le" IS NULL) = ("rapports_mensuels"."envoye_par" IS NULL) AND ("rapports_mensuels"."envoye_par" IS NULL OR char_length("rapports_mensuels"."envoye_par") <= 200))
);
--> statement-breakpoint
CREATE TABLE "sante_instances" (
	"tenant_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"instance_id" uuid NOT NULL,
	"etat" "etat_sante" DEFAULT 'inconnue' NOT NULL,
	"raisons" text[] DEFAULT '{}' NOT NULL,
	"depuis" timestamp with time zone DEFAULT now() NOT NULL,
	"derniere_reussite_le" timestamp with time zone,
	"prochaine_attendue_le" timestamp with time zone,
	CONSTRAINT "sante_instances_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "sante_instances_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "sante_instances_instance_unique" UNIQUE("tenant_id","instance_id"),
	CONSTRAINT "sante_instances_raisons_codes" CHECK (cardinality("sante_instances"."raisons") <= 16 AND array_to_string("sante_instances"."raisons", ',') ~ '^([a-z][a-z0-9_.-]{0,63}(,[a-z][a-z0-9_.-]{0,63})*)?$')
);
--> statement-breakpoint
CREATE TABLE "suspensions_abus" (
	"tenant_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"organisation_id" uuid NOT NULL,
	"etape" "etape_suspension" NOT NULL,
	"motif" "motif_suspension" NOT NULL,
	"posee_par" text NOT NULL,
	"posee_le" timestamp with time zone DEFAULT now() NOT NULL,
	"levee_par" text,
	"levee_le" timestamp with time zone,
	CONSTRAINT "suspensions_abus_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "suspensions_abus_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "suspensions_abus_posee_par_borne" CHECK (length(btrim("suspensions_abus"."posee_par")) > 0 AND char_length("suspensions_abus"."posee_par") <= 200),
	CONSTRAINT "suspensions_abus_levee_coherente" CHECK (("suspensions_abus"."levee_le" IS NULL) = ("suspensions_abus"."levee_par" IS NULL) AND ("suspensions_abus"."levee_par" IS NULL OR char_length("suspensions_abus"."levee_par") <= 200))
);
--> statement-breakpoint
ALTER TABLE "liens_retour" ADD CONSTRAINT "liens_retour_organisation_fk" FOREIGN KEY ("tenant_id","organisation_id") REFERENCES "public"."organisations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rapports_mensuels" ADD CONSTRAINT "rapports_mensuels_organisation_fk" FOREIGN KEY ("tenant_id","organisation_id") REFERENCES "public"."organisations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sante_instances" ADD CONSTRAINT "sante_instances_instance_fk" FOREIGN KEY ("tenant_id","instance_id") REFERENCES "public"."instances"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suspensions_abus" ADD CONSTRAINT "suspensions_abus_organisation_fk" FOREIGN KEY ("tenant_id","organisation_id") REFERENCES "public"."organisations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "liens_retour_tenant_id_idx" ON "liens_retour" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "mesures_bases_tenant_id_idx" ON "mesures_bases" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "mesures_bases_tenant_debut_idx" ON "mesures_bases" USING btree ("tenant_id","debut");--> statement-breakpoint
CREATE INDEX "rapports_mensuels_tenant_id_idx" ON "rapports_mensuels" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "sante_instances_tenant_id_idx" ON "sante_instances" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "suspensions_abus_tenant_id_idx" ON "suspensions_abus" USING btree ("tenant_id");--> statement-breakpoint

-- ===== Partie écrite à la main : RLS activée ET forcée, droits les plus restrictifs (aucun DELETE ni TRUNCATE), acteur obligatoire, journal d'audit =====
ALTER TABLE "public"."sante_instances" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."sante_instances" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY isolation_client ON "public"."sante_instances" FOR ALL TO console_app USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY lecture_equipe ON "public"."sante_instances" FOR SELECT TO console_equipe USING (tenant_id IS NOT NULL);--> statement-breakpoint
REVOKE ALL ON TABLE "public"."sante_instances" FROM PUBLIC;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "public"."sante_instances" TO console_app;--> statement-breakpoint
GRANT UPDATE ("etat", "raisons", "depuis", "derniere_reussite_le", "prochaine_attendue_le") ON TABLE "public"."sante_instances" TO console_app;--> statement-breakpoint
CREATE POLICY acteur_obligatoire_insert ON "public"."sante_instances" AS RESTRICTIVE FOR INSERT TO console_app WITH CHECK (NULLIF(current_setting('app.acteur', true), '') IS NOT NULL);--> statement-breakpoint
CREATE POLICY acteur_obligatoire_update ON "public"."sante_instances" AS RESTRICTIVE FOR UPDATE TO console_app USING (true) WITH CHECK (NULLIF(current_setting('app.acteur', true), '') IS NOT NULL);--> statement-breakpoint
GRANT SELECT ON TABLE "public"."sante_instances" TO console_equipe;--> statement-breakpoint
CREATE TRIGGER sante_instances_audit AFTER INSERT OR UPDATE OR DELETE ON "public"."sante_instances" FOR EACH ROW EXECUTE FUNCTION public.audit_ecrire();--> statement-breakpoint
ALTER TABLE "public"."liens_retour" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."liens_retour" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY isolation_client ON "public"."liens_retour" FOR ALL TO console_app USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY lecture_equipe ON "public"."liens_retour" FOR SELECT TO console_equipe USING (tenant_id IS NOT NULL);--> statement-breakpoint
REVOKE ALL ON TABLE "public"."liens_retour" FROM PUBLIC;--> statement-breakpoint
GRANT SELECT ON TABLE "public"."liens_retour" TO console_app;--> statement-breakpoint
GRANT SELECT ON TABLE "public"."liens_retour" TO console_equipe;--> statement-breakpoint
CREATE TRIGGER liens_retour_audit AFTER INSERT OR UPDATE OR DELETE ON "public"."liens_retour" FOR EACH ROW EXECUTE FUNCTION public.audit_ecrire();--> statement-breakpoint
ALTER TABLE "public"."rapports_mensuels" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."rapports_mensuels" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY isolation_client ON "public"."rapports_mensuels" FOR ALL TO console_app USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY lecture_equipe ON "public"."rapports_mensuels" FOR SELECT TO console_equipe USING (tenant_id IS NOT NULL);--> statement-breakpoint
REVOKE ALL ON TABLE "public"."rapports_mensuels" FROM PUBLIC;--> statement-breakpoint
GRANT SELECT ON TABLE "public"."rapports_mensuels" TO console_app;--> statement-breakpoint
GRANT SELECT ON TABLE "public"."rapports_mensuels" TO console_equipe;--> statement-breakpoint
CREATE TRIGGER rapports_mensuels_audit AFTER INSERT OR UPDATE OR DELETE ON "public"."rapports_mensuels" FOR EACH ROW EXECUTE FUNCTION public.audit_ecrire();--> statement-breakpoint
ALTER TABLE "public"."suspensions_abus" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."suspensions_abus" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY isolation_client ON "public"."suspensions_abus" FOR ALL TO console_app USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY lecture_equipe ON "public"."suspensions_abus" FOR SELECT TO console_equipe USING (tenant_id IS NOT NULL);--> statement-breakpoint
REVOKE ALL ON TABLE "public"."suspensions_abus" FROM PUBLIC;--> statement-breakpoint
CREATE POLICY ajout_equipe ON "public"."suspensions_abus" FOR INSERT TO console_equipe WITH CHECK (tenant_id IS NOT NULL);--> statement-breakpoint
CREATE POLICY changement_equipe ON "public"."suspensions_abus" FOR UPDATE TO console_equipe USING (tenant_id IS NOT NULL AND levee_le IS NULL) WITH CHECK (tenant_id IS NOT NULL);--> statement-breakpoint
GRANT SELECT ON TABLE "public"."suspensions_abus" TO console_app;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "public"."suspensions_abus" TO console_equipe;--> statement-breakpoint
GRANT UPDATE ("levee_par", "levee_le") ON TABLE "public"."suspensions_abus" TO console_equipe;--> statement-breakpoint
CREATE POLICY acteur_obligatoire_insert ON "public"."suspensions_abus" AS RESTRICTIVE FOR INSERT TO console_equipe WITH CHECK (NULLIF(current_setting('app.acteur', true), '') IS NOT NULL);--> statement-breakpoint
CREATE POLICY acteur_obligatoire_update ON "public"."suspensions_abus" AS RESTRICTIVE FOR UPDATE TO console_equipe USING (true) WITH CHECK (NULLIF(current_setting('app.acteur', true), '') IS NOT NULL);--> statement-breakpoint
CREATE TRIGGER suspensions_abus_audit AFTER INSERT OR UPDATE OR DELETE ON "public"."suspensions_abus" FOR EACH ROW EXECUTE FUNCTION public.audit_ecrire_equipe();--> statement-breakpoint
ALTER TABLE "public"."mesures_bases" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."mesures_bases" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY isolation_client ON "public"."mesures_bases" FOR ALL TO console_app USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY lecture_equipe ON "public"."mesures_bases" FOR SELECT TO console_equipe USING (tenant_id IS NOT NULL);--> statement-breakpoint
CREATE POLICY ajout_equipe ON "public"."mesures_bases" FOR INSERT TO console_equipe WITH CHECK (tenant_id IS NOT NULL);--> statement-breakpoint
REVOKE ALL ON TABLE "public"."mesures_bases" FROM PUBLIC;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "public"."mesures_bases" TO console_equipe;--> statement-breakpoint
CREATE POLICY acteur_obligatoire_insert ON "public"."mesures_bases" AS RESTRICTIVE FOR INSERT TO console_equipe WITH CHECK (NULLIF(current_setting('app.acteur', true), '') IS NOT NULL);--> statement-breakpoint
CREATE TRIGGER mesures_bases_audit AFTER INSERT OR UPDATE OR DELETE ON "public"."mesures_bases" FOR EACH ROW EXECUTE FUNCTION public.audit_ecrire_equipe();--> statement-breakpoint
-- console_lecture (A-188) : lecture seule, RLS appliquée comme console_app. Le rôle est créé par la PR T5-01-ops (ops/socle/postgres/init/02-roles.sql), fusionnée avant.
CREATE POLICY isolation_lecture ON "public"."sante_instances" FOR SELECT TO console_lecture USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT ON TABLE "public"."sante_instances" TO console_lecture;--> statement-breakpoint
CREATE POLICY isolation_lecture ON "public"."liens_retour" FOR SELECT TO console_lecture USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT ON TABLE "public"."liens_retour" TO console_lecture;--> statement-breakpoint
CREATE POLICY isolation_lecture ON "public"."rapports_mensuels" FOR SELECT TO console_lecture USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT ON TABLE "public"."rapports_mensuels" TO console_lecture;--> statement-breakpoint
CREATE POLICY isolation_lecture ON "public"."suspensions_abus" FOR SELECT TO console_lecture USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT ON TABLE "public"."suspensions_abus" TO console_lecture;--> statement-breakpoint
CREATE POLICY isolation_lecture ON "public"."mesures_bases" FOR SELECT TO console_lecture USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT ON TABLE "public"."mesures_bases" TO console_lecture;--> statement-breakpoint
CREATE POLICY isolation_lecture ON "public"."alertes" FOR SELECT TO console_lecture USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT ON TABLE "public"."alertes" TO console_lecture;--> statement-breakpoint
CREATE POLICY isolation_lecture ON "public"."agregats_quotidiens" FOR SELECT TO console_lecture USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT ON TABLE "public"."agregats_quotidiens" TO console_lecture;--> statement-breakpoint
-- pg_partman ne pose ni RLS ni FORCE sur les partitions qu'il crée (vérifié en 0010) : cette fonction les pose sur chaque partition de mesures_bases, défaut comprise, et ferme tout droit direct.
-- Copie de executions_proteger_partitions (ADR 0054) : rejouable ; non SECURITY DEFINER ; EXECUTE retiré à PUBLIC, console_app, console_equipe et console_lecture.
CREATE FUNCTION public.mesures_bases_proteger_partitions()
RETURNS integer
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $fonction$
DECLARE
  v_partition regclass;
  v_nombre integer := 0;
BEGIN
  FOR v_partition IN SELECT i.inhrelid::regclass FROM pg_inherits i WHERE i.inhparent = 'public.mesures_bases'::regclass LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', v_partition);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', v_partition);
    EXECUTE format('REVOKE ALL ON TABLE %s FROM PUBLIC, console_app, console_equipe, console_lecture', v_partition);
    IF NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = v_partition AND p.polname = 'isolation_client') THEN
      EXECUTE format($p$CREATE POLICY isolation_client ON %s FOR ALL TO console_app USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, v_partition);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = v_partition AND p.polname = 'lecture_equipe') THEN
      EXECUTE format('CREATE POLICY lecture_equipe ON %s FOR SELECT TO console_equipe USING (tenant_id IS NOT NULL)', v_partition);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = v_partition AND p.polname = 'isolation_lecture') THEN
      EXECUTE format($p$CREATE POLICY isolation_lecture ON %s FOR SELECT TO console_lecture USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, v_partition);
    END IF;
    v_nombre := v_nombre + 1;
  END LOOP;
  RETURN v_nombre;
END
$fonction$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.mesures_bases_proteger_partitions() FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.mesures_bases_proteger_partitions() FROM console_app, console_equipe, console_lecture;--> statement-breakpoint
-- Partitions mensuelles de mesures_bases par pg_partman 5, 4 mois d'avance ; les partitions déjà créées sont protégées tout de suite.
SELECT partman.create_parent(
  p_parent_table => 'public.mesures_bases',
  p_control => 'debut',
  p_interval => '1 month',
  p_premake => 4
);--> statement-breakpoint
SELECT public.mesures_bases_proteger_partitions();
