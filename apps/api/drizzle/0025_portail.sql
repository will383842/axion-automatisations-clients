-- T6-01a (ADR 0119) : tables du portail dans console, métadonnées seulement. ADDITIVE : aucun DROP, DELETE, TRUNCATE, RENAME ni changement de type. Numéro 0025 (après 0024, T4-34a).
-- Une seule transaction : en cas d'échec rien n'est créé (échec fermé). Aucune fonction nouvelle ; audit_ecrire existe déjà.
-- Aucun jeton en clair : invitations ne garde que l'empreinte HMAC-SHA-256 (64 caractères hexadécimaux). Aucune colonne ne peut ranger un texte de demande (C-604).
CREATE TYPE "public"."etat_invitation" AS ENUM('envoyee', 'acceptee', 'expiree', 'revoquee');--> statement-breakpoint
CREATE TYPE "public"."etat_premiers_pas" AS ENUM('a_faire', 'en_cours', 'fait', 'passe');--> statement-breakpoint
CREATE TYPE "public"."role_invitation" AS ENUM('dirigeant', 'administrateur', 'utilisateur');--> statement-breakpoint
CREATE TABLE "accords_logo" (
	"tenant_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"organisation_id" uuid NOT NULL,
	"confirme_par" uuid NOT NULL,
	"confirme_le" timestamp with time zone DEFAULT now() NOT NULL,
	"reference_preuve" text NOT NULL,
	"retire_le" timestamp with time zone,
	CONSTRAINT "accords_logo_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "accords_logo_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "accords_logo_preuve_forme" CHECK ("accords_logo"."reference_preuve" ~ '^[A-Za-z0-9][A-Za-z0-9_./:-]{0,127}$')
);
--> statement-breakpoint
CREATE TABLE "compteurs_ecrans" (
	"tenant_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"organisation_id" uuid NOT NULL,
	"ecran" text NOT NULL,
	"jour" date NOT NULL,
	"ouvertures" integer DEFAULT 0 NOT NULL,
	"aides" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "compteurs_ecrans_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "compteurs_ecrans_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "compteurs_ecrans_jour_unique" UNIQUE("tenant_id","organisation_id","ecran","jour"),
	CONSTRAINT "compteurs_ecrans_ecran_code" CHECK ("compteurs_ecrans"."ecran" ~ '^[A-Za-z][A-Za-z0-9_.-]{0,63}$'),
	CONSTRAINT "compteurs_ecrans_positifs" CHECK ("compteurs_ecrans"."ouvertures" >= 0 AND "compteurs_ecrans"."aides" >= 0)
);
--> statement-breakpoint
CREATE TABLE "invitations" (
	"tenant_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"organisation_id" uuid NOT NULL,
	"role" "role_invitation" NOT NULL,
	"empreinte_invitation" text NOT NULL,
	"expire_le" timestamp with time zone NOT NULL,
	"etat" "etat_invitation" DEFAULT 'envoyee' NOT NULL,
	"invite_par" uuid NOT NULL,
	"acceptee_le" timestamp with time zone,
	"cree_le" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invitations_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "invitations_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "invitations_empreinte_unique" UNIQUE("tenant_id","empreinte_invitation"),
	CONSTRAINT "invitations_empreinte_forme" CHECK ("invitations"."empreinte_invitation" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "invitations_expiration" CHECK ("invitations"."expire_le" > "invitations"."cree_le" AND "invitations"."expire_le" <= "invitations"."cree_le" + interval '30 days'),
	CONSTRAINT "invitations_acceptation" CHECK (("invitations"."etat" = 'acceptee') = ("invitations"."acceptee_le" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "preferences_notifications" (
	"tenant_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"utilisateur" uuid NOT NULL,
	"cle_envoi" text NOT NULL,
	"activee" boolean DEFAULT true NOT NULL,
	"resume_hebdomadaire" boolean DEFAULT false NOT NULL,
	"maj_le" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "preferences_notifications_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "preferences_notifications_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "preferences_notifications_cle_unique" UNIQUE("tenant_id","utilisateur","cle_envoi"),
	CONSTRAINT "preferences_notifications_cle_code" CHECK ("preferences_notifications"."cle_envoi" ~ '^[a-z][a-z0-9_.-]{0,63}$')
);
--> statement-breakpoint
CREATE TABLE "progression_premiers_pas" (
	"tenant_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"organisation_id" uuid NOT NULL,
	"utilisateur" uuid NOT NULL,
	"etape" text NOT NULL,
	"etat" "etat_premiers_pas" DEFAULT 'a_faire' NOT NULL,
	"commence_le" timestamp with time zone,
	"termine_le" timestamp with time zone,
	"maj_le" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "progression_premiers_pas_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "progression_premiers_pas_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "progression_premiers_pas_etape_unique" UNIQUE("tenant_id","utilisateur","etape"),
	CONSTRAINT "progression_premiers_pas_etape_code" CHECK ("progression_premiers_pas"."etape" ~ '^[a-z][a-z0-9_.-]{0,63}$'),
	CONSTRAINT "progression_premiers_pas_fin_coherente" CHECK (("progression_premiers_pas"."etat" = 'fait') = ("progression_premiers_pas"."termine_le" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "accords_logo" ADD CONSTRAINT "accords_logo_organisation_fk" FOREIGN KEY ("tenant_id","organisation_id") REFERENCES "public"."organisations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compteurs_ecrans" ADD CONSTRAINT "compteurs_ecrans_organisation_fk" FOREIGN KEY ("tenant_id","organisation_id") REFERENCES "public"."organisations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_organisation_fk" FOREIGN KEY ("tenant_id","organisation_id") REFERENCES "public"."organisations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "progression_premiers_pas" ADD CONSTRAINT "progression_premiers_pas_organisation_fk" FOREIGN KEY ("tenant_id","organisation_id") REFERENCES "public"."organisations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "accords_logo_tenant_id_idx" ON "accords_logo" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "accords_logo_un_vivant" ON "accords_logo" USING btree ("tenant_id","organisation_id") WHERE "accords_logo"."retire_le" IS NULL;--> statement-breakpoint
CREATE INDEX "compteurs_ecrans_tenant_id_idx" ON "compteurs_ecrans" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "invitations_tenant_id_idx" ON "invitations" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "preferences_notifications_tenant_id_idx" ON "preferences_notifications" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "progression_premiers_pas_tenant_id_idx" ON "progression_premiers_pas" USING btree ("tenant_id");--> statement-breakpoint
-- ===== Partie écrite à la main (drizzle-kit ne génère ni RLS, ni droits, ni déclencheurs), modèle exact de cles_ia_client (0024) =====
ALTER TABLE "public"."progression_premiers_pas" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."progression_premiers_pas" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY isolation_client ON "public"."progression_premiers_pas" FOR ALL TO console_app USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY lecture_equipe ON "public"."progression_premiers_pas" FOR SELECT TO console_equipe USING (tenant_id IS NOT NULL);--> statement-breakpoint
REVOKE ALL ON TABLE "public"."progression_premiers_pas" FROM PUBLIC;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "public"."progression_premiers_pas" TO console_app;--> statement-breakpoint
GRANT UPDATE ("etat", "commence_le", "termine_le", "maj_le") ON TABLE "public"."progression_premiers_pas" TO console_app;--> statement-breakpoint
CREATE POLICY acteur_obligatoire_insert ON "public"."progression_premiers_pas" AS RESTRICTIVE FOR INSERT TO console_app WITH CHECK (NULLIF(current_setting('app.acteur', true), '') IS NOT NULL);--> statement-breakpoint
CREATE POLICY acteur_obligatoire_update ON "public"."progression_premiers_pas" AS RESTRICTIVE FOR UPDATE TO console_app USING (true) WITH CHECK (NULLIF(current_setting('app.acteur', true), '') IS NOT NULL);--> statement-breakpoint
GRANT SELECT ON TABLE "public"."progression_premiers_pas" TO console_equipe;--> statement-breakpoint
ALTER TABLE "public"."preferences_notifications" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."preferences_notifications" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY isolation_client ON "public"."preferences_notifications" FOR ALL TO console_app USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY lecture_equipe ON "public"."preferences_notifications" FOR SELECT TO console_equipe USING (tenant_id IS NOT NULL);--> statement-breakpoint
REVOKE ALL ON TABLE "public"."preferences_notifications" FROM PUBLIC;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "public"."preferences_notifications" TO console_app;--> statement-breakpoint
GRANT UPDATE ("activee", "resume_hebdomadaire", "maj_le") ON TABLE "public"."preferences_notifications" TO console_app;--> statement-breakpoint
CREATE POLICY acteur_obligatoire_insert ON "public"."preferences_notifications" AS RESTRICTIVE FOR INSERT TO console_app WITH CHECK (NULLIF(current_setting('app.acteur', true), '') IS NOT NULL);--> statement-breakpoint
CREATE POLICY acteur_obligatoire_update ON "public"."preferences_notifications" AS RESTRICTIVE FOR UPDATE TO console_app USING (true) WITH CHECK (NULLIF(current_setting('app.acteur', true), '') IS NOT NULL);--> statement-breakpoint
GRANT SELECT ON TABLE "public"."preferences_notifications" TO console_equipe;--> statement-breakpoint
-- Invitation à usage unique : une invitation acceptée, expirée ou révoquée ne change plus. empreinte_invitation est lisible par console_app (une empreinte HMAC dont la clé est hors base n'est pas le jeton) ; jamais modifiable.
ALTER TABLE "public"."invitations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."invitations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY isolation_client ON "public"."invitations" FOR ALL TO console_app USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY lecture_equipe ON "public"."invitations" FOR SELECT TO console_equipe USING (tenant_id IS NOT NULL);--> statement-breakpoint
REVOKE ALL ON TABLE "public"."invitations" FROM PUBLIC;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "public"."invitations" TO console_app;--> statement-breakpoint
GRANT UPDATE ("etat", "acceptee_le") ON TABLE "public"."invitations" TO console_app;--> statement-breakpoint
CREATE POLICY acteur_obligatoire_insert ON "public"."invitations" AS RESTRICTIVE FOR INSERT TO console_app WITH CHECK (NULLIF(current_setting('app.acteur', true), '') IS NOT NULL);--> statement-breakpoint
CREATE POLICY acteur_obligatoire_update ON "public"."invitations" AS RESTRICTIVE FOR UPDATE TO console_app USING (true) WITH CHECK (NULLIF(current_setting('app.acteur', true), '') IS NOT NULL);--> statement-breakpoint
CREATE POLICY usage_unique ON "public"."invitations" AS RESTRICTIVE FOR UPDATE TO console_app USING (etat = 'envoyee') WITH CHECK (tenant_id IS NOT NULL);--> statement-breakpoint
GRANT SELECT ON TABLE "public"."invitations" TO console_equipe;--> statement-breakpoint
CREATE TRIGGER invitations_audit AFTER INSERT OR UPDATE OR DELETE ON "public"."invitations" FOR EACH ROW EXECUTE FUNCTION public.audit_ecrire();--> statement-breakpoint
-- Un accord de logo se retire (retire_le) et ne se modifie plus ensuite ; un nouvel accord = une nouvelle ligne.
ALTER TABLE "public"."accords_logo" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."accords_logo" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY isolation_client ON "public"."accords_logo" FOR ALL TO console_app USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY lecture_equipe ON "public"."accords_logo" FOR SELECT TO console_equipe USING (tenant_id IS NOT NULL);--> statement-breakpoint
REVOKE ALL ON TABLE "public"."accords_logo" FROM PUBLIC;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "public"."accords_logo" TO console_app;--> statement-breakpoint
GRANT UPDATE ("retire_le") ON TABLE "public"."accords_logo" TO console_app;--> statement-breakpoint
CREATE POLICY acteur_obligatoire_insert ON "public"."accords_logo" AS RESTRICTIVE FOR INSERT TO console_app WITH CHECK (NULLIF(current_setting('app.acteur', true), '') IS NOT NULL);--> statement-breakpoint
CREATE POLICY acteur_obligatoire_update ON "public"."accords_logo" AS RESTRICTIVE FOR UPDATE TO console_app USING (true) WITH CHECK (NULLIF(current_setting('app.acteur', true), '') IS NOT NULL);--> statement-breakpoint
CREATE POLICY accord_retire_definitif ON "public"."accords_logo" AS RESTRICTIVE FOR UPDATE TO console_app USING (retire_le IS NULL) WITH CHECK (tenant_id IS NOT NULL);--> statement-breakpoint
GRANT SELECT ON TABLE "public"."accords_logo" TO console_equipe;--> statement-breakpoint
CREATE TRIGGER accords_logo_audit AFTER INSERT OR UPDATE OR DELETE ON "public"."accords_logo" FOR EACH ROW EXECUTE FUNCTION public.audit_ecrire();--> statement-breakpoint
ALTER TABLE "public"."compteurs_ecrans" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."compteurs_ecrans" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY isolation_client ON "public"."compteurs_ecrans" FOR ALL TO console_app USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY lecture_equipe ON "public"."compteurs_ecrans" FOR SELECT TO console_equipe USING (tenant_id IS NOT NULL);--> statement-breakpoint
REVOKE ALL ON TABLE "public"."compteurs_ecrans" FROM PUBLIC;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "public"."compteurs_ecrans" TO console_app;--> statement-breakpoint
GRANT UPDATE ("ouvertures", "aides") ON TABLE "public"."compteurs_ecrans" TO console_app;--> statement-breakpoint
CREATE POLICY acteur_obligatoire_insert ON "public"."compteurs_ecrans" AS RESTRICTIVE FOR INSERT TO console_app WITH CHECK (NULLIF(current_setting('app.acteur', true), '') IS NOT NULL);--> statement-breakpoint
CREATE POLICY acteur_obligatoire_update ON "public"."compteurs_ecrans" AS RESTRICTIVE FOR UPDATE TO console_app USING (true) WITH CHECK (NULLIF(current_setting('app.acteur', true), '') IS NOT NULL);--> statement-breakpoint
GRANT SELECT ON TABLE "public"."compteurs_ecrans" TO console_equipe;
-- console_lecture (T5-01) : AUCUN droit sur ces tables. Aucun DELETE ni TRUNCATE accordé.
-- Retour arrière (documenté, jamais exécuté par la chaîne) : REVOKE seulement ; rien n'est détruit. REVOKE SELECT, INSERT ON ces cinq tables FROM console_app ; REVOKE UPDATE (colonnes ci-dessus) FROM console_app ; REVOKE SELECT FROM console_equipe.
