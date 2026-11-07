-- T4-28a (ADR 0125) : déploiement d'un module chez un client : tests à blanc et journal des déploiements, une instance par (client, automatisation, environnement). ADDITIVE : aucun DROP, DELETE, TRUNCATE, RENAME ni changement de type. Numéro 0028 (après 0027, T4-27a).
-- Aucune fonction nouvelle (audit_ecrire existe, 0001/0007), aucune valeur ajoutée à une énumération existante (resultat_version est réutilisée telle quelle), aucune colonne ajoutée à instances.
CREATE TYPE "public"."resultat_test_a_blanc" AS ENUM('reussi', 'echoue');--> statement-breakpoint
CREATE TABLE "deploiements_instance" (
	"tenant_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"instance_id" uuid NOT NULL,
	"version_depart_id" uuid,
	"version_cible_id" uuid NOT NULL,
	"configuration_id" uuid,
	"resultat" "resultat_version" NOT NULL,
	"cause" text,
	"vague" integer,
	"auteur" text NOT NULL,
	"cree_le" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deploiements_instance_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "deploiements_instance_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "deploiements_instance_versions_distinctes" CHECK ("deploiements_instance"."version_depart_id" IS NULL OR "deploiements_instance"."version_depart_id" <> "deploiements_instance"."version_cible_id"),
	CONSTRAINT "deploiements_instance_cause_selon_resultat" CHECK (("deploiements_instance"."resultat" = 'ok') = ("deploiements_instance"."cause" IS NULL)),
	CONSTRAINT "deploiements_instance_cause_format" CHECK ("deploiements_instance"."cause" IS NULL OR "deploiements_instance"."cause" ~ '^[a-z0-9_.-]{1,64}$'),
	CONSTRAINT "deploiements_instance_vague_bornee" CHECK ("deploiements_instance"."vague" IS NULL OR "deploiements_instance"."vague" BETWEEN 0 AND 100000),
	CONSTRAINT "deploiements_instance_auteur_borne" CHECK (length(btrim("deploiements_instance"."auteur")) > 0 AND char_length("deploiements_instance"."auteur") <= 200)
);
--> statement-breakpoint
CREATE TABLE "tests_a_blanc" (
	"tenant_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"instance_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"configuration_id" uuid NOT NULL,
	"resultat" "resultat_test_a_blanc" NOT NULL,
	"lectures" integer DEFAULT 0 NOT NULL,
	"brouillons" integer DEFAULT 0 NOT NULL,
	"envois" integer DEFAULT 0 NOT NULL,
	"duree_ms" integer NOT NULL,
	"code_erreur" text,
	"auteur" text NOT NULL,
	"cree_le" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tests_a_blanc_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "tests_a_blanc_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "tests_a_blanc_compteurs_bornes" CHECK ("tests_a_blanc"."lectures" BETWEEN 0 AND 1000000 AND "tests_a_blanc"."brouillons" BETWEEN 0 AND 1000000 AND "tests_a_blanc"."envois" BETWEEN 0 AND 1000000),
	CONSTRAINT "tests_a_blanc_duree_bornee" CHECK ("tests_a_blanc"."duree_ms" BETWEEN 0 AND 3600000),
	CONSTRAINT "tests_a_blanc_reussi_sans_envoi" CHECK ("tests_a_blanc"."resultat" <> 'reussi' OR ("tests_a_blanc"."envois" = 0 AND "tests_a_blanc"."code_erreur" IS NULL)),
	CONSTRAINT "tests_a_blanc_echec_motive" CHECK ("tests_a_blanc"."resultat" <> 'echoue' OR "tests_a_blanc"."code_erreur" IS NOT NULL),
	CONSTRAINT "tests_a_blanc_code_erreur_format" CHECK ("tests_a_blanc"."code_erreur" IS NULL OR "tests_a_blanc"."code_erreur" ~ '^[a-z0-9_.-]{1,64}$'),
	CONSTRAINT "tests_a_blanc_auteur_borne" CHECK (length(btrim("tests_a_blanc"."auteur")) > 0 AND char_length("tests_a_blanc"."auteur") <= 200)
);
--> statement-breakpoint
ALTER TABLE "deploiements_instance" ADD CONSTRAINT "deploiements_instance_instance_fk" FOREIGN KEY ("tenant_id","instance_id") REFERENCES "public"."instances"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deploiements_instance" ADD CONSTRAINT "deploiements_instance_configuration_fk" FOREIGN KEY ("tenant_id","instance_id","configuration_id") REFERENCES "public"."configurations"("tenant_id","instance_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deploiements_instance" ADD CONSTRAINT "deploiements_instance_version_depart_fk" FOREIGN KEY ("version_depart_id") REFERENCES "public"."versions_automatisation"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deploiements_instance" ADD CONSTRAINT "deploiements_instance_version_cible_fk" FOREIGN KEY ("version_cible_id") REFERENCES "public"."versions_automatisation"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tests_a_blanc" ADD CONSTRAINT "tests_a_blanc_instance_fk" FOREIGN KEY ("tenant_id","instance_id") REFERENCES "public"."instances"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tests_a_blanc" ADD CONSTRAINT "tests_a_blanc_configuration_fk" FOREIGN KEY ("tenant_id","instance_id","configuration_id") REFERENCES "public"."configurations"("tenant_id","instance_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tests_a_blanc" ADD CONSTRAINT "tests_a_blanc_version_fk" FOREIGN KEY ("version_id") REFERENCES "public"."versions_automatisation"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "deploiements_instance_tenant_id_idx" ON "deploiements_instance" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "deploiements_instance_instance_idx" ON "deploiements_instance" USING btree ("tenant_id","instance_id","cree_le");--> statement-breakpoint
CREATE INDEX "tests_a_blanc_tenant_id_idx" ON "tests_a_blanc" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "tests_a_blanc_instance_idx" ON "tests_a_blanc" USING btree ("tenant_id","instance_id","cree_le");--> statement-breakpoint
CREATE UNIQUE INDEX "instances_une_par_automatisation" ON "instances" USING btree ("tenant_id","automatisation_id","environnement") WHERE "instances"."automatisation_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "configurations_tenant_instance_id_unique" ON "configurations" USING btree ("tenant_id","instance_id","id");--> statement-breakpoint
-- ===== Partie écrite à la main (drizzle-kit ne génère ni RLS, ni droits, ni déclencheurs) : deux tables de client, en ajout seul (aucun UPDATE, DELETE ni TRUNCATE accordé). =====
ALTER TABLE "public"."tests_a_blanc" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."tests_a_blanc" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY isolation_client ON "public"."tests_a_blanc" FOR ALL TO console_app USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY lecture_equipe ON "public"."tests_a_blanc" FOR SELECT TO console_equipe USING (tenant_id IS NOT NULL);--> statement-breakpoint
CREATE POLICY auteur_insertion ON "public"."tests_a_blanc" AS RESTRICTIVE FOR INSERT TO console_app WITH CHECK (auteur = NULLIF(current_setting('app.acteur', true), ''));--> statement-breakpoint
REVOKE ALL ON TABLE "public"."tests_a_blanc" FROM PUBLIC;--> statement-breakpoint
GRANT SELECT ON TABLE "public"."tests_a_blanc" TO console_app;--> statement-breakpoint
GRANT INSERT ("tenant_id", "instance_id", "version_id", "configuration_id", "resultat", "lectures", "brouillons", "envois", "duree_ms", "code_erreur", "auteur") ON TABLE "public"."tests_a_blanc" TO console_app;--> statement-breakpoint
GRANT SELECT ON TABLE "public"."tests_a_blanc" TO console_equipe;--> statement-breakpoint
CREATE TRIGGER tests_a_blanc_audit AFTER INSERT OR UPDATE OR DELETE ON "public"."tests_a_blanc" FOR EACH ROW EXECUTE FUNCTION public.audit_ecrire();--> statement-breakpoint
ALTER TABLE "public"."deploiements_instance" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."deploiements_instance" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY isolation_client ON "public"."deploiements_instance" FOR ALL TO console_app USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY lecture_equipe ON "public"."deploiements_instance" FOR SELECT TO console_equipe USING (tenant_id IS NOT NULL);--> statement-breakpoint
CREATE POLICY auteur_insertion ON "public"."deploiements_instance" AS RESTRICTIVE FOR INSERT TO console_app WITH CHECK (auteur = NULLIF(current_setting('app.acteur', true), ''));--> statement-breakpoint
REVOKE ALL ON TABLE "public"."deploiements_instance" FROM PUBLIC;--> statement-breakpoint
GRANT SELECT ON TABLE "public"."deploiements_instance" TO console_app;--> statement-breakpoint
GRANT INSERT ("tenant_id", "instance_id", "version_depart_id", "version_cible_id", "configuration_id", "resultat", "cause", "vague", "auteur") ON TABLE "public"."deploiements_instance" TO console_app;--> statement-breakpoint
GRANT SELECT ON TABLE "public"."deploiements_instance" TO console_equipe;--> statement-breakpoint
CREATE TRIGGER deploiements_instance_audit AFTER INSERT OR UPDATE OR DELETE ON "public"."deploiements_instance" FOR EACH ROW EXECUTE FUNCTION public.audit_ecrire();
-- Aucun droit pour console_lecture ni PUBLIC. Aucune colonne d'instances ajoutée : aucun GRANT par colonne à ajouter sur instances.
-- Retour arrière (documenté, jamais exécuté par la chaîne) : REVOKE seulement ; rien n'est détruit.
