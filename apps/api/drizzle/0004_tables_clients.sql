CREATE TYPE "public"."environnement_instance" AS ENUM('test', 'production');--> statement-breakpoint
CREATE TYPE "public"."etat_instance" AS ENUM('active', 'pause', 'erreur', 'livree');--> statement-breakpoint
CREATE TYPE "public"."formule_instance" AS ENUM('abonnement', 'achat', 'installation_maintenance');--> statement-breakpoint
CREATE TYPE "public"."role_contact" AS ENUM('principal', 'facturation', 'technique', 'autre');--> statement-breakpoint
CREATE TYPE "public"."statut_organisation" AS ENUM('prospect', 'en_signature', 'client', 'ancien_client');--> statement-breakpoint
CREATE TYPE "public"."taille_organisation" AS ENUM('tpe', 'pme', 'eti', 'grande');--> statement-breakpoint
CREATE TABLE "contacts" (
	"tenant_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"organisation_id" uuid NOT NULL,
	"nom" text NOT NULL,
	"email" text NOT NULL,
	"role" "role_contact" DEFAULT 'principal' NOT NULL,
	"acces_portail" boolean DEFAULT false NOT NULL,
	"keycloak_id" uuid,
	"cree_le" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contacts_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "contacts_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "contacts_email_format" CHECK ("contacts"."email" ~ '^[^@[:space:]]+@[^@[:space:]]+$')
);
--> statement-breakpoint
CREATE TABLE "instances" (
	"tenant_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"organisation_id" uuid NOT NULL,
	"code_automatisation" text NOT NULL,
	"formule" "formule_instance" NOT NULL,
	"environnement" "environnement_instance" NOT NULL,
	"etat" "etat_instance" DEFAULT 'active' NOT NULL,
	"cree_le" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "instances_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "instances_tenant_id_id_unique" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "organisations" (
	"tenant_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"console_client_id" uuid NOT NULL,
	"raison_sociale" text NOT NULL,
	"siren" text,
	"metier" text,
	"code_naf" text,
	"taille" "taille_organisation",
	"modele_ia_defaut" text,
	"statut" "statut_organisation" DEFAULT 'prospect' NOT NULL,
	"responsable_axion" text,
	"crm_company_id" text,
	"cree_le" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organisations_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "organisations_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "organisations_tenant_id_console_client_id_unique" UNIQUE("tenant_id","console_client_id"),
	CONSTRAINT "organisations_id_tenant" CHECK ("organisations"."id" = "organisations"."tenant_id"),
	CONSTRAINT "organisations_console_client_id_derive" CHECK ("organisations"."console_client_id" = "organisations"."tenant_id"),
	CONSTRAINT "organisations_siren_format" CHECK ("organisations"."siren" ~ '^[0-9]{9}$'),
	CONSTRAINT "organisations_code_naf_format" CHECK ("organisations"."code_naf" ~ '^[0-9]{2}\.[0-9]{2}[A-Z]$')
);
--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_organisation_fk" FOREIGN KEY ("tenant_id","organisation_id") REFERENCES "public"."organisations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instances" ADD CONSTRAINT "instances_organisation_fk" FOREIGN KEY ("tenant_id","organisation_id") REFERENCES "public"."organisations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "contacts_tenant_id_idx" ON "contacts" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "instances_tenant_id_idx" ON "instances" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "organisations_tenant_id_idx" ON "organisations" USING btree ("tenant_id");--> statement-breakpoint
-- Partie écrite à la main (drizzle-kit ne génère ni RLS, ni droits, ni déclencheurs), dans la même migration que les tables (ADR 0044).
-- L'organisation « plateforme » est insérée AVANT FORCE ROW LEVEL SECURITY : la migration n'a ni client actif ni politique d'écriture sur ces tables.
INSERT INTO "public"."organisations" ("tenant_id", "id", "console_client_id", "raison_sociale", "statut") VALUES ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 'Plateforme AXION', 'prospect');--> statement-breakpoint
ALTER TABLE "public"."organisations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."organisations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY isolation_client ON "public"."organisations" FOR ALL TO console_app USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY lecture_equipe ON "public"."organisations" FOR SELECT TO console_equipe USING (tenant_id IS NOT NULL);--> statement-breakpoint
REVOKE ALL ON TABLE "public"."organisations" FROM PUBLIC;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "public"."organisations" TO console_app;--> statement-breakpoint
GRANT SELECT ON TABLE "public"."organisations" TO console_equipe;--> statement-breakpoint
CREATE TRIGGER organisations_audit AFTER INSERT OR UPDATE OR DELETE ON "public"."organisations" FOR EACH ROW EXECUTE FUNCTION public.audit_ecrire();--> statement-breakpoint
ALTER TABLE "public"."contacts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."contacts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY isolation_client ON "public"."contacts" FOR ALL TO console_app USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY lecture_equipe ON "public"."contacts" FOR SELECT TO console_equipe USING (tenant_id IS NOT NULL);--> statement-breakpoint
REVOKE ALL ON TABLE "public"."contacts" FROM PUBLIC;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "public"."contacts" TO console_app;--> statement-breakpoint
GRANT SELECT ON TABLE "public"."contacts" TO console_equipe;--> statement-breakpoint
ALTER TABLE "public"."instances" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."instances" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY isolation_client ON "public"."instances" FOR ALL TO console_app USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY lecture_equipe ON "public"."instances" FOR SELECT TO console_equipe USING (tenant_id IS NOT NULL);--> statement-breakpoint
REVOKE ALL ON TABLE "public"."instances" FROM PUBLIC;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "public"."instances" TO console_app;--> statement-breakpoint
GRANT SELECT ON TABLE "public"."instances" TO console_equipe;--> statement-breakpoint
CREATE TRIGGER instances_audit AFTER INSERT OR UPDATE OR DELETE ON "public"."instances" FOR EACH ROW EXECUTE FUNCTION public.audit_ecrire();
