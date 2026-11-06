-- T4-34a (ADR 0117) : modèle d'IA par client et par automatisation ; référence de la clé d'IA propre du client. ADDITIVE : aucun DROP, DELETE, TRUNCATE, RENAME ni changement de type. Numéro 0024 (après 0023, T5-01b).
-- Échec fermé : une seule transaction ; une valeur existante de organisations.modele_ia_defaut hors forme fait échouer le VALIDATE, la transaction est annulée et rien n'est modifié ni supprimé.
-- Aucune valeur de clé en base, jamais : seulement la référence bao:clients/<tenant>/<uuid> rendue par rangerIdentifiant (T1A-06). Aucune fonction nouvelle, aucun déclencheur nouveau (audit_ecrire existe déjà).
CREATE TYPE "public"."etat_cle_ia" AS ENUM('a_tester', 'active', 'refusee', 'desactivee');--> statement-breakpoint
CREATE TABLE "cles_ia_client" (
	"tenant_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"organisation_id" uuid NOT NULL,
	"fournisseur" text NOT NULL,
	"reference_coffre" text NOT NULL,
	"etat" "etat_cle_ia" DEFAULT 'a_tester' NOT NULL,
	"dernier_essai_le" timestamp with time zone,
	"dernier_refus_code" text,
	"cree_par" text NOT NULL,
	"cree_le" timestamp with time zone DEFAULT now() NOT NULL,
	"desactivee_le" timestamp with time zone,
	CONSTRAINT "cles_ia_client_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "cles_ia_client_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "cles_ia_client_reference_unique" UNIQUE("tenant_id","reference_coffre"),
	CONSTRAINT "cles_ia_client_fournisseur_code" CHECK ("cles_ia_client"."fournisseur" ~ '^[a-z][a-z0-9_.-]{0,63}$'),
	CONSTRAINT "cles_ia_client_reference_du_client" CHECK ("cles_ia_client"."reference_coffre" ~ ('^bao:clients/' || "cles_ia_client"."tenant_id"::text || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') AND char_length("cles_ia_client"."reference_coffre") <= 96),
	CONSTRAINT "cles_ia_client_refus_code" CHECK ("cles_ia_client"."dernier_refus_code" IS NULL OR "cles_ia_client"."dernier_refus_code" ~ '^[a-z][a-z0-9_.-]{0,63}$'),
	CONSTRAINT "cles_ia_client_refus_coherent" CHECK ("cles_ia_client"."etat" <> 'refusee' OR "cles_ia_client"."dernier_refus_code" IS NOT NULL),
	CONSTRAINT "cles_ia_client_cree_par_borne" CHECK (length(btrim("cles_ia_client"."cree_par")) > 0 AND char_length("cles_ia_client"."cree_par") <= 200),
	CONSTRAINT "cles_ia_client_desactivation_coherente" CHECK (("cles_ia_client"."etat" = 'desactivee') = ("cles_ia_client"."desactivee_le" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "instances" ADD COLUMN "modele_ia" text;--> statement-breakpoint
ALTER TABLE "cles_ia_client" ADD CONSTRAINT "cles_ia_client_organisation_fk" FOREIGN KEY ("tenant_id","organisation_id") REFERENCES "public"."organisations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cles_ia_client_tenant_id_idx" ON "cles_ia_client" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "cles_ia_client_une_vivante_idx" ON "cles_ia_client" USING btree ("tenant_id","organisation_id","fournisseur") WHERE "cles_ia_client"."etat" <> 'desactivee';--> statement-breakpoint
ALTER TABLE "instances" ADD CONSTRAINT "instances_modele_ia_forme" CHECK ("instances"."modele_ia" IS NULL OR ("instances"."modele_ia" ~ '^[a-z0-9][a-z0-9._:/-]{0,127}$' AND "instances"."modele_ia" !~ '\.\.'));--> statement-breakpoint
ALTER TABLE "organisations" ADD CONSTRAINT "organisations_modele_ia_defaut_forme" CHECK ("organisations"."modele_ia_defaut" IS NULL OR ("organisations"."modele_ia_defaut" ~ '^[a-z0-9][a-z0-9._:/-]{0,127}$' AND "organisations"."modele_ia_defaut" !~ '\.\.')) NOT VALID;--> statement-breakpoint
ALTER TABLE "organisations" VALIDATE CONSTRAINT "organisations_modele_ia_defaut_forme";--> statement-breakpoint
-- ===== Partie écrite à la main (drizzle-kit ne génère ni RLS, ni droits, ni déclencheurs), modèle exact de connexions (0010) =====
ALTER TABLE "public"."cles_ia_client" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."cles_ia_client" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY isolation_client ON "public"."cles_ia_client" FOR ALL TO console_app USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY lecture_equipe ON "public"."cles_ia_client" FOR SELECT TO console_equipe USING (tenant_id IS NOT NULL);--> statement-breakpoint
REVOKE ALL ON TABLE "public"."cles_ia_client" FROM PUBLIC;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "public"."cles_ia_client" TO console_app;--> statement-breakpoint
-- reference_coffre, fournisseur, organisation_id, cree_par ne se modifient jamais : un remplacement = une nouvelle ligne.
GRANT UPDATE ("etat", "dernier_essai_le", "dernier_refus_code", "desactivee_le") ON TABLE "public"."cles_ia_client" TO console_app;--> statement-breakpoint
CREATE POLICY creation_cle ON "public"."cles_ia_client" AS RESTRICTIVE FOR INSERT TO console_app WITH CHECK (etat = 'a_tester' AND desactivee_le IS NULL AND dernier_essai_le IS NULL AND cree_par = NULLIF(current_setting('app.acteur', true), ''));--> statement-breakpoint
CREATE POLICY desactivation_definitive ON "public"."cles_ia_client" AS RESTRICTIVE FOR UPDATE TO console_app USING (tenant_id IS NOT NULL AND etat <> 'desactivee') WITH CHECK (tenant_id IS NOT NULL);--> statement-breakpoint
CREATE POLICY acteur_obligatoire_insert ON "public"."cles_ia_client" AS RESTRICTIVE FOR INSERT TO console_app WITH CHECK (NULLIF(current_setting('app.acteur', true), '') IS NOT NULL);--> statement-breakpoint
CREATE POLICY acteur_obligatoire_update ON "public"."cles_ia_client" AS RESTRICTIVE FOR UPDATE TO console_app USING (true) WITH CHECK (NULLIF(current_setting('app.acteur', true), '') IS NOT NULL);--> statement-breakpoint
GRANT SELECT ON TABLE "public"."cles_ia_client" TO console_equipe;--> statement-breakpoint
CREATE TRIGGER cles_ia_client_audit AFTER INSERT OR UPDATE OR DELETE ON "public"."cles_ia_client" FOR EACH ROW EXECUTE FUNCTION public.audit_ecrire();--> statement-breakpoint
-- instances.modele_ia : droits par colonne (0019 a retiré les droits de table entière à console_app).
GRANT SELECT ("modele_ia") ON TABLE "public"."instances" TO console_app;--> statement-breakpoint
GRANT INSERT ("modele_ia") ON TABLE "public"."instances" TO console_app;--> statement-breakpoint
GRANT UPDATE ("modele_ia") ON TABLE "public"."instances" TO console_app;
-- organisations.modele_ia_defaut : déjà lisible et modifiable par console_app (0004) ; aucun droit nouveau.
-- console_lecture (T5-01) : AUCUN droit sur cles_ia_client (un tableau de bord n'en a pas besoin).
-- Retour arrière (documenté, jamais exécuté par la chaîne) : REVOKE seulement ; rien n'est détruit. REVOKE SELECT, INSERT ON cles_ia_client FROM console_app ; REVOKE UPDATE (etat, dernier_essai_le, dernier_refus_code, desactivee_le) ON cles_ia_client FROM console_app ; REVOKE SELECT (modele_ia), INSERT (modele_ia), UPDATE (modele_ia) ON instances FROM console_app ; REVOKE SELECT ON cles_ia_client FROM console_equipe.
