ALTER TYPE "public"."motif_a_trancher" ADD VALUE 'lien_crm_different';--> statement-breakpoint
ALTER TYPE "public"."motif_a_trancher" ADD VALUE 'identifiant_crm_incoherent';--> statement-breakpoint
CREATE TABLE "alertes_c3" (
	"tenant_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"type" text NOT NULL,
	"reference" text NOT NULL,
	"cree_le" timestamp with time zone DEFAULT now() NOT NULL,
	"confirmee_le" timestamp with time zone,
	CONSTRAINT "alertes_c3_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "alertes_c3_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "alertes_c3_tenant_id_event_id_type_reference_unique" UNIQUE("tenant_id","event_id","type","reference"),
	CONSTRAINT "alertes_c3_type" CHECK ("alertes_c3"."type" IN ('exclusion_a_reporter_dans_le_hub', 'effacement_demande', 'ecart_propose', 'fait_hors_perimetre')),
	CONSTRAINT "alertes_c3_reference_bornee" CHECK (char_length("alertes_c3"."reference") BETWEEN 1 AND 200)
);
--> statement-breakpoint
CREATE TABLE "contenus_c3" (
	"tenant_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"contenu" jsonb NOT NULL,
	"recu_le" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contenus_c3_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "contenus_c3_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "contenus_c3_tenant_id_event_id_unique" UNIQUE("tenant_id","event_id")
);
--> statement-breakpoint
CREATE TABLE "donnees_crm_c3" (
	"tenant_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"organisation_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"sorte" text NOT NULL,
	"contenu" jsonb NOT NULL,
	"cree_le" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "donnees_crm_c3_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "donnees_crm_c3_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "donnees_crm_c3_tenant_id_event_id_sorte_unique" UNIQUE("tenant_id","event_id","sorte"),
	CONSTRAINT "donnees_crm_c3_sorte" CHECK ("donnees_crm_c3"."sorte" IN ('copie', 'ecart', 'apporteur'))
);
--> statement-breakpoint
CREATE TABLE "exclusions_c3" (
	"tenant_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"portee" text NOT NULL,
	"empreinte" text NOT NULL,
	"genre" text NOT NULL,
	"cree_le" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "exclusions_c3_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "exclusions_c3_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "exclusions_c3_tenant_id_portee_empreinte_unique" UNIQUE("tenant_id","portee","empreinte"),
	CONSTRAINT "exclusions_c3_empreinte_format" CHECK ("exclusions_c3"."empreinte" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "exclusions_c3_genre" CHECK ("exclusions_c3"."genre" IN ('desabonnement', 'opposition')),
	CONSTRAINT "exclusions_c3_portee" CHECK (("exclusions_c3"."genre" = 'opposition') = ("exclusions_c3"."portee" = '*') AND char_length("exclusions_c3"."portee") BETWEEN 1 AND 200)
);
--> statement-breakpoint
ALTER TABLE "donnees_crm_c3" ADD CONSTRAINT "donnees_crm_c3_organisation_fk" FOREIGN KEY ("tenant_id","organisation_id") REFERENCES "public"."organisations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "alertes_c3_tenant_id_idx" ON "alertes_c3" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "contenus_c3_tenant_id_idx" ON "contenus_c3" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "donnees_crm_c3_tenant_id_idx" ON "donnees_crm_c3" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "exclusions_c3_tenant_id_idx" ON "exclusions_c3" USING btree ("tenant_id");
-- RLS activée ET forcée sur chaque table, deux politiques du modèle, droits d'insertion et de lecture seulement (ADR 0106).
ALTER TABLE "public"."alertes_c3" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."alertes_c3" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY isolation_client ON "public"."alertes_c3" FOR ALL TO console_app USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY lecture_equipe ON "public"."alertes_c3" FOR SELECT TO console_equipe USING (tenant_id IS NOT NULL);--> statement-breakpoint
REVOKE ALL ON TABLE "public"."alertes_c3" FROM PUBLIC;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "public"."alertes_c3" TO console_app;--> statement-breakpoint
GRANT UPDATE ("confirmee_le") ON TABLE "public"."alertes_c3" TO console_app;--> statement-breakpoint
GRANT SELECT ON TABLE "public"."alertes_c3" TO console_equipe;--> statement-breakpoint
ALTER TABLE "public"."contenus_c3" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."contenus_c3" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY isolation_client ON "public"."contenus_c3" FOR ALL TO console_app USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY lecture_equipe ON "public"."contenus_c3" FOR SELECT TO console_equipe USING (tenant_id IS NOT NULL);--> statement-breakpoint
REVOKE ALL ON TABLE "public"."contenus_c3" FROM PUBLIC;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "public"."contenus_c3" TO console_app;--> statement-breakpoint
GRANT SELECT ON TABLE "public"."contenus_c3" TO console_equipe;--> statement-breakpoint
ALTER TABLE "public"."donnees_crm_c3" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."donnees_crm_c3" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY isolation_client ON "public"."donnees_crm_c3" FOR ALL TO console_app USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY lecture_equipe ON "public"."donnees_crm_c3" FOR SELECT TO console_equipe USING (tenant_id IS NOT NULL);--> statement-breakpoint
REVOKE ALL ON TABLE "public"."donnees_crm_c3" FROM PUBLIC;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "public"."donnees_crm_c3" TO console_app;--> statement-breakpoint
GRANT SELECT ON TABLE "public"."donnees_crm_c3" TO console_equipe;--> statement-breakpoint
ALTER TABLE "public"."exclusions_c3" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."exclusions_c3" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY isolation_client ON "public"."exclusions_c3" FOR ALL TO console_app USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY lecture_equipe ON "public"."exclusions_c3" FOR SELECT TO console_equipe USING (tenant_id IS NOT NULL);--> statement-breakpoint
REVOKE ALL ON TABLE "public"."exclusions_c3" FROM PUBLIC;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "public"."exclusions_c3" TO console_app;--> statement-breakpoint
GRANT SELECT ON TABLE "public"."exclusions_c3" TO console_equipe;
