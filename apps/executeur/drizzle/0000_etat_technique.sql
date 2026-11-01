CREATE TYPE "public"."etat_intention" AS ENUM('ecrite', 'faite', 'a_trancher');--> statement-breakpoint
CREATE TYPE "public"."garantie_intention" AS ENUM('idempotent_par_cle', 'verifiable_apres_coup', 'au_plus_une_fois');--> statement-breakpoint
CREATE TYPE "public"."issue_execution" AS ENUM('reussite', 'erreur');--> statement-breakpoint
CREATE TYPE "public"."statut_etape" AS ENUM('en_cours', 'reussie', 'en_erreur');--> statement-breakpoint
CREATE TABLE "curseurs" (
	"tenant_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"instance_id" uuid NOT NULL,
	"declencheur" text NOT NULL,
	"valeur" text NOT NULL,
	"change_le" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "curseurs_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "curseurs_tenant_id_instance_id_declencheur_unique" UNIQUE("tenant_id","instance_id","declencheur"),
	CONSTRAINT "curseurs_forme" CHECK ("curseurs"."declencheur" ~ '^[a-z0-9][a-z0-9_.-]{0,63}$' AND length("curseurs"."valeur") <= 512)
);
--> statement-breakpoint
CREATE TABLE "executions" (
	"tenant_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"instance_id" uuid NOT NULL,
	"automatisation" text NOT NULL,
	"debut" timestamp with time zone DEFAULT now() NOT NULL,
	"fin" timestamp with time zone,
	"issue" "issue_execution",
	CONSTRAINT "executions_tenant_id_id_debut_pk" PRIMARY KEY("tenant_id","id","debut"),
	CONSTRAINT "executions_fin_complete" CHECK (("executions"."fin" IS NULL) = ("executions"."issue" IS NULL) AND ("executions"."fin" IS NULL OR "executions"."fin" >= "executions"."debut")),
	CONSTRAINT "executions_automatisation_code" CHECK ("executions"."automatisation" ~ '^[a-z0-9][a-z0-9_.-]{0,63}$')
) PARTITION BY RANGE ("debut");
--> statement-breakpoint
CREATE TABLE "intentions" (
	"tenant_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"execution_id" uuid NOT NULL,
	"debut_execution" timestamp with time zone NOT NULL,
	"cle_intention" text NOT NULL,
	"garantie" "garantie_intention" NOT NULL,
	"etat" "etat_intention" DEFAULT 'ecrite' NOT NULL,
	"cree_le" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "intentions_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "intentions_tenant_id_cle_intention_unique" UNIQUE("tenant_id","cle_intention"),
	CONSTRAINT "intentions_cle_forme" CHECK ("intentions"."cle_intention" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$')
);
--> statement-breakpoint
CREATE TABLE "journal_etape" (
	"tenant_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"execution_id" uuid NOT NULL,
	"debut_execution" timestamp with time zone NOT NULL,
	"etape" text NOT NULL,
	"cle" text NOT NULL,
	"statut" "statut_etape" DEFAULT 'en_cours' NOT NULL,
	"sortie_chiffree" "bytea",
	"sortie_cle" text,
	"sortie_version" integer,
	"cree_le" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "journal_etape_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "journal_etape_tenant_id_execution_id_etape_cle_unique" UNIQUE("tenant_id","execution_id","etape","cle"),
	CONSTRAINT "journal_etape_code" CHECK ("journal_etape"."etape" ~ '^[a-z0-9][a-z0-9_.-]{0,63}$' AND "journal_etape"."cle" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
	CONSTRAINT "journal_etape_sortie_complete" CHECK (("journal_etape"."sortie_chiffree" IS NULL) = ("journal_etape"."sortie_cle" IS NULL) AND ("journal_etape"."sortie_chiffree" IS NULL) = ("journal_etape"."sortie_version" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "intentions" ADD CONSTRAINT "intentions_execution_fk" FOREIGN KEY ("tenant_id","execution_id","debut_execution") REFERENCES "public"."executions"("tenant_id","id","debut") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_etape" ADD CONSTRAINT "journal_etape_execution_fk" FOREIGN KEY ("tenant_id","execution_id","debut_execution") REFERENCES "public"."executions"("tenant_id","id","debut") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "curseurs_tenant_id_idx" ON "curseurs" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "executions_tenant_id_idx" ON "executions" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "executions_tenant_id_instance_id_idx" ON "executions" USING btree ("tenant_id","instance_id");--> statement-breakpoint
CREATE INDEX "intentions_tenant_id_idx" ON "intentions" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "journal_etape_tenant_id_idx" ON "journal_etape" USING btree ("tenant_id");

--> statement-breakpoint
-- Partie écrite à la main (drizzle-kit ne génère ni partitions, ni RLS, ni droits), dans la même migration que les tables (ADR 0035, 0101).
-- Partitions journalières par pg_partman, créées AVANT la RLS : create_parent lit la table parente. Les partitions reçoivent leur RLS par securiserPartitions() (connexion.ts) ;
-- aucun droit n'est donné sur elles à moteur_app : l'application passe toujours par la table parente. Aucun DROP, aucun TRUNCATE, aucune fonction écrite ici (ADR 0041).
SELECT partman.create_parent(p_parent_table := 'public.executions', p_control := 'debut', p_interval := '1 day', p_premake := 7, p_start_partition := to_char(now() - interval '8 days', 'YYYY-MM-DD'), p_jobmon := false);
--> statement-breakpoint
ALTER TABLE "public"."executions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."executions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY isolation_client ON "public"."executions" FOR ALL TO moteur_app USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY garde_client ON "public"."executions" AS RESTRICTIVE FOR ALL TO moteur_app USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY lecture_equipe ON "public"."executions" FOR SELECT TO moteur_equipe USING (tenant_id IS NOT NULL);
--> statement-breakpoint
REVOKE ALL ON TABLE "public"."executions" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "public"."executions" TO moteur_app;
--> statement-breakpoint
GRANT SELECT ON TABLE "public"."executions" TO moteur_equipe;
--> statement-breakpoint
CREATE POLICY purge_lecture ON "public"."executions" FOR SELECT TO moteur_purge USING (tenant_id IS NOT NULL);
--> statement-breakpoint
CREATE POLICY purge_suppression ON "public"."executions" FOR DELETE TO moteur_purge USING (tenant_id IS NOT NULL);
--> statement-breakpoint
GRANT SELECT, DELETE ON TABLE "public"."executions" TO moteur_purge;
--> statement-breakpoint
ALTER TABLE "public"."journal_etape" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."journal_etape" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY isolation_client ON "public"."journal_etape" FOR ALL TO moteur_app USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY garde_client ON "public"."journal_etape" AS RESTRICTIVE FOR ALL TO moteur_app USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY lecture_equipe ON "public"."journal_etape" FOR SELECT TO moteur_equipe USING (tenant_id IS NOT NULL);
--> statement-breakpoint
REVOKE ALL ON TABLE "public"."journal_etape" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "public"."journal_etape" TO moteur_app;
--> statement-breakpoint
GRANT SELECT ON TABLE "public"."journal_etape" TO moteur_equipe;
--> statement-breakpoint
CREATE POLICY purge_lecture ON "public"."journal_etape" FOR SELECT TO moteur_purge USING (tenant_id IS NOT NULL);
--> statement-breakpoint
CREATE POLICY purge_suppression ON "public"."journal_etape" FOR DELETE TO moteur_purge USING (tenant_id IS NOT NULL);
--> statement-breakpoint
GRANT SELECT, DELETE ON TABLE "public"."journal_etape" TO moteur_purge;
--> statement-breakpoint
ALTER TABLE "public"."intentions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."intentions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY isolation_client ON "public"."intentions" FOR ALL TO moteur_app USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY garde_client ON "public"."intentions" AS RESTRICTIVE FOR ALL TO moteur_app USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY lecture_equipe ON "public"."intentions" FOR SELECT TO moteur_equipe USING (tenant_id IS NOT NULL);
--> statement-breakpoint
REVOKE ALL ON TABLE "public"."intentions" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "public"."intentions" TO moteur_app;
--> statement-breakpoint
GRANT SELECT ON TABLE "public"."intentions" TO moteur_equipe;
--> statement-breakpoint
CREATE POLICY purge_lecture ON "public"."intentions" FOR SELECT TO moteur_purge USING (tenant_id IS NOT NULL);
--> statement-breakpoint
CREATE POLICY purge_suppression ON "public"."intentions" FOR DELETE TO moteur_purge USING (tenant_id IS NOT NULL);
--> statement-breakpoint
GRANT SELECT, DELETE ON TABLE "public"."intentions" TO moteur_purge;
--> statement-breakpoint
ALTER TABLE "public"."curseurs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."curseurs" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY isolation_client ON "public"."curseurs" FOR ALL TO moteur_app USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY garde_client ON "public"."curseurs" AS RESTRICTIVE FOR ALL TO moteur_app USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY lecture_equipe ON "public"."curseurs" FOR SELECT TO moteur_equipe USING (tenant_id IS NOT NULL);
--> statement-breakpoint
REVOKE ALL ON TABLE "public"."curseurs" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "public"."curseurs" TO moteur_app;
--> statement-breakpoint
GRANT SELECT ON TABLE "public"."curseurs" TO moteur_equipe;
--> statement-breakpoint
GRANT UPDATE ("fin", "issue") ON TABLE "public"."executions" TO moteur_app;
--> statement-breakpoint
GRANT UPDATE ("statut", "sortie_chiffree", "sortie_cle", "sortie_version") ON TABLE "public"."journal_etape" TO moteur_app;
--> statement-breakpoint
GRANT UPDATE ("etat") ON TABLE "public"."intentions" TO moteur_app;
--> statement-breakpoint
GRANT UPDATE ("valeur", "change_le") ON TABLE "public"."curseurs" TO moteur_app;
-- Pas d'insertion directe en état final : une exécution naît sans fin ni issue, une étape « en_cours », une intention « ecrite ». Le passage à l'état final est une mise à jour.
--> statement-breakpoint
CREATE POLICY depart_execution ON "public"."executions" AS RESTRICTIVE FOR INSERT TO moteur_app WITH CHECK ("fin" IS NULL AND "issue" IS NULL);
--> statement-breakpoint
CREATE POLICY depart_etape ON "public"."journal_etape" AS RESTRICTIVE FOR INSERT TO moteur_app WITH CHECK ("statut" = 'en_cours');
--> statement-breakpoint
CREATE POLICY depart_intention ON "public"."intentions" AS RESTRICTIVE FOR INSERT TO moteur_app WITH CHECK ("etat" = 'ecrite');
