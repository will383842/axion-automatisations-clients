-- T5-04a (ADR 0126) : file d'alertes : occurrences (compteur, relances) et clôtures motivées, une seule alerte en cours par client et par cause. ADDITIVE : aucun DROP, DELETE, TRUNCATE, RENAME ni changement de type. Numéro 0029 (après 0028, T4-28a).
-- Aucune fonction nouvelle (audit_ecrire existe), aucune valeur ajoutée à une énumération, aucune colonne ajoutée à alertes, aucune politique existante modifiée : la politique transitions_alerte de la 0010 reste telle quelle.
-- Échec fermé : une seule transaction ; si deux alertes ouvertes partagent déjà une clé de regroupement, l'index unique échoue et RIEN n'est créé (jamais de nettoyage pour faire passer la migration).
CREATE TABLE "clotures_alertes" (
	"tenant_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"alerte_id" uuid NOT NULL,
	"raison" text NOT NULL,
	"auteur" text NOT NULL,
	"cree_le" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clotures_alertes_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "clotures_alertes_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "clotures_alertes_une_par_alerte" UNIQUE("tenant_id","alerte_id"),
	CONSTRAINT "clotures_alertes_raison_code" CHECK ("clotures_alertes"."raison" ~ '^[a-z][a-z0-9_.-]{0,63}$'),
	CONSTRAINT "clotures_alertes_auteur_borne" CHECK (length(btrim("clotures_alertes"."auteur")) > 0 AND char_length("clotures_alertes"."auteur") <= 200)
);
--> statement-breakpoint
CREATE TABLE "occurrences_alertes" (
	"tenant_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"alerte_id" uuid NOT NULL,
	"instance_id" uuid,
	"relance" boolean DEFAULT false NOT NULL,
	"recue_le" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "occurrences_alertes_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "occurrences_alertes_tenant_id_id_unique" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "clotures_alertes" ADD CONSTRAINT "clotures_alertes_alerte_fk" FOREIGN KEY ("tenant_id","alerte_id") REFERENCES "public"."alertes"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "occurrences_alertes" ADD CONSTRAINT "occurrences_alertes_alerte_fk" FOREIGN KEY ("tenant_id","alerte_id") REFERENCES "public"."alertes"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "occurrences_alertes" ADD CONSTRAINT "occurrences_alertes_instance_fk" FOREIGN KEY ("tenant_id","instance_id") REFERENCES "public"."instances"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "clotures_alertes_tenant_id_idx" ON "clotures_alertes" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "occurrences_alertes_tenant_id_idx" ON "occurrences_alertes" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "occurrences_alertes_alerte_idx" ON "occurrences_alertes" USING btree ("tenant_id","alerte_id","recue_le");--> statement-breakpoint
CREATE UNIQUE INDEX "alertes_une_ouverte_par_cle" ON "alertes" USING btree ("tenant_id","cle_regroupement") WHERE "alertes"."cle_regroupement" IS NOT NULL AND "alertes"."etat" IN ('ouverte', 'acquittee');--> statement-breakpoint
-- ===== Partie écrite à la main (drizzle-kit ne génère ni RLS, ni droits, ni déclencheurs) : deux tables de client en ajout seul (aucun UPDATE, DELETE ni TRUNCATE accordé), une politique restrictive de plus sur alertes. =====
ALTER TABLE "public"."occurrences_alertes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."occurrences_alertes" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "public"."occurrences_alertes" FROM PUBLIC;--> statement-breakpoint
CREATE POLICY isolation_client ON "public"."occurrences_alertes" FOR ALL TO console_app USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY lecture_equipe ON "public"."occurrences_alertes" FOR SELECT TO console_equipe USING (tenant_id IS NOT NULL);--> statement-breakpoint
CREATE POLICY isolation_lecture ON "public"."occurrences_alertes" FOR SELECT TO console_lecture USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY acteur_obligatoire_insert ON "public"."occurrences_alertes" AS RESTRICTIVE FOR INSERT TO console_app WITH CHECK (NULLIF(current_setting('app.acteur', true), '') IS NOT NULL);--> statement-breakpoint
CREATE POLICY occurrence_sur_alerte_ouverte ON "public"."occurrences_alertes" AS RESTRICTIVE FOR INSERT TO console_app WITH CHECK (EXISTS (SELECT 1 FROM "public"."alertes" a WHERE a.tenant_id = occurrences_alertes.tenant_id AND a.id = occurrences_alertes.alerte_id AND a.etat IN ('ouverte', 'acquittee')));--> statement-breakpoint
GRANT SELECT ON TABLE "public"."occurrences_alertes" TO console_app;--> statement-breakpoint
GRANT INSERT ("tenant_id", "alerte_id", "instance_id", "relance") ON TABLE "public"."occurrences_alertes" TO console_app;--> statement-breakpoint
GRANT SELECT ON TABLE "public"."occurrences_alertes" TO console_equipe;--> statement-breakpoint
GRANT SELECT ON TABLE "public"."occurrences_alertes" TO console_lecture;--> statement-breakpoint
CREATE TRIGGER occurrences_alertes_audit AFTER INSERT OR UPDATE OR DELETE ON "public"."occurrences_alertes" FOR EACH ROW EXECUTE FUNCTION public.audit_ecrire();--> statement-breakpoint
ALTER TABLE "public"."clotures_alertes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."clotures_alertes" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "public"."clotures_alertes" FROM PUBLIC;--> statement-breakpoint
CREATE POLICY isolation_client ON "public"."clotures_alertes" FOR ALL TO console_app USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY lecture_equipe ON "public"."clotures_alertes" FOR SELECT TO console_equipe USING (tenant_id IS NOT NULL);--> statement-breakpoint
CREATE POLICY isolation_lecture ON "public"."clotures_alertes" FOR SELECT TO console_lecture USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY auteur_insertion ON "public"."clotures_alertes" AS RESTRICTIVE FOR INSERT TO console_app WITH CHECK (auteur = NULLIF(current_setting('app.acteur', true), ''));--> statement-breakpoint
CREATE POLICY cloture_sur_alerte_ouverte ON "public"."clotures_alertes" AS RESTRICTIVE FOR INSERT TO console_app WITH CHECK (EXISTS (SELECT 1 FROM "public"."alertes" a WHERE a.tenant_id = clotures_alertes.tenant_id AND a.id = clotures_alertes.alerte_id AND a.etat IN ('ouverte', 'acquittee')));--> statement-breakpoint
GRANT SELECT ON TABLE "public"."clotures_alertes" TO console_app;--> statement-breakpoint
GRANT INSERT ("tenant_id", "alerte_id", "raison", "auteur") ON TABLE "public"."clotures_alertes" TO console_app;--> statement-breakpoint
GRANT SELECT ON TABLE "public"."clotures_alertes" TO console_equipe;--> statement-breakpoint
GRANT SELECT ON TABLE "public"."clotures_alertes" TO console_lecture;--> statement-breakpoint
CREATE TRIGGER clotures_alertes_audit AFTER INSERT OR UPDATE OR DELETE ON "public"."clotures_alertes" FOR EACH ROW EXECUTE FUNCTION public.audit_ecrire();--> statement-breakpoint
-- alertes : une restriction de plus (jamais une permission de plus). Le passage à « close » exige une ligne de clotures_alertes pour cette alerte. Les lignes déjà closes ne sont pas relues.
CREATE POLICY cloture_motivee ON "public"."alertes" AS RESTRICTIVE FOR UPDATE TO console_app USING (true) WITH CHECK (etat <> 'close' OR EXISTS (SELECT 1 FROM "public"."clotures_alertes" c WHERE c.tenant_id = alertes.tenant_id AND c.alerte_id = alertes.id));
-- Aucun GRANT nouveau sur alertes. Retour arrière (documenté, jamais exécuté par la chaîne) : REVOKE des droits ajoutés ; tables, index et politiques RESTENT (rien n'est détruit).
