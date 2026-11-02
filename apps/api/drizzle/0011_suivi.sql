CREATE TYPE "public"."base_legale" AS ENUM('contrat', 'obligation_legale', 'interet_legitime', 'consentement');--> statement-breakpoint
CREATE TYPE "public"."canal_demande" AS ENUM('courriel', 'telephone', 'portail', 'rendez_vous', 'autre');--> statement-breakpoint
CREATE TYPE "public"."etat_cellule" AS ENUM('active', 'saturee', 'hors_ligne', 'maintenance');--> statement-breakpoint
CREATE TYPE "public"."mode_cellule" AS ENUM('mutualise', 'dedie');--> statement-breakpoint
CREATE TYPE "public"."niveau_priorite" AS ENUM('basse', 'normale', 'haute', 'urgente');--> statement-breakpoint
CREATE TYPE "public"."statut_demande" AS ENUM('nouvelle', 'en_cours', 'en_attente', 'resolue', 'close');--> statement-breakpoint
CREATE TYPE "public"."statut_proposition" AS ENUM('brouillon', 'envoyee', 'acceptee', 'refusee', 'expiree');--> statement-breakpoint
CREATE TYPE "public"."ton_theme" AS ENUM('formel', 'chaleureux', 'neutre');--> statement-breakpoint
CREATE TYPE "public"."type_audit" AS ENUM('decouverte', 'approfondi', 'suivi');--> statement-breakpoint
CREATE TYPE "public"."type_note" AS ENUM('appel', 'demande', 'incident');--> statement-breakpoint
CREATE TABLE "audits_client" (
	"tenant_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"organisation_id" uuid NOT NULL,
	"type" "type_audit" NOT NULL,
	"date_audit" date NOT NULL,
	"identifiant_hub" text NOT NULL,
	"compte_rendu_ref" text,
	"cree_le" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audits_client_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "audits_client_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "audits_client_tenant_id_identifiant_hub_unique" UNIQUE("tenant_id","identifiant_hub"),
	CONSTRAINT "audits_client_identifiant_hub_format" CHECK ("audits_client"."identifiant_hub" ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$'),
	CONSTRAINT "audits_client_compte_rendu_ref_format" CHECK ("audits_client"."compte_rendu_ref" IS NULL OR ("audits_client"."compte_rendu_ref" ~ '^[A-Za-z0-9][A-Za-z0-9_./-]{0,254}$' AND "audits_client"."compte_rendu_ref" !~ '\.\.'))
);
--> statement-breakpoint
CREATE TABLE "besoins" (
	"tenant_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"audit_id" uuid NOT NULL,
	"categorie" text NOT NULL,
	"priorite" "niveau_priorite" DEFAULT 'normale' NOT NULL,
	"minutes_perdues_estimees" integer NOT NULL,
	"automatisation_id" uuid,
	"cree_le" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "besoins_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "besoins_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "besoins_categorie_code" CHECK ("besoins"."categorie" ~ '^[a-z][a-z0-9_.-]{0,63}$'),
	CONSTRAINT "besoins_minutes_bornees" CHECK ("besoins"."minutes_perdues_estimees" BETWEEN 0 AND 1000000)
);
--> statement-breakpoint
CREATE TABLE "cellules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"adresse_interne" text NOT NULL,
	"mode" "mode_cellule" NOT NULL,
	"capacite" integer NOT NULL,
	"nombre_instances" integer DEFAULT 0 NOT NULL,
	"version_image" text NOT NULL,
	"dernier_signal_le" timestamp with time zone,
	"etat" "etat_cellule" DEFAULT 'hors_ligne' NOT NULL,
	"cree_le" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cellules_code_unique" UNIQUE("code"),
	CONSTRAINT "cellules_code_format" CHECK ("cellules"."code" ~ '^[a-z][a-z0-9_-]{0,62}$'),
	CONSTRAINT "cellules_adresse_format" CHECK ("cellules"."adresse_interne" ~ '^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$'),
	CONSTRAINT "cellules_capacite_bornee" CHECK ("cellules"."capacite" BETWEEN 1 AND 100000),
	CONSTRAINT "cellules_instances_bornees" CHECK ("cellules"."nombre_instances" BETWEEN 0 AND 100000),
	CONSTRAINT "cellules_version_image_format" CHECK ("cellules"."version_image" ~ '^[a-z0-9][a-z0-9._+-]{0,63}$')
);
--> statement-breakpoint
CREATE TABLE "demandes" (
	"tenant_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"organisation_id" uuid NOT NULL,
	"automatisation_id" uuid,
	"canal" "canal_demande" NOT NULL,
	"categorie" text NOT NULL,
	"priorite" "niveau_priorite" DEFAULT 'normale' NOT NULL,
	"statut" "statut_demande" DEFAULT 'nouvelle' NOT NULL,
	"responsable" text,
	"reference_texte" text NOT NULL,
	"cree_le" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "demandes_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "demandes_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "demandes_tenant_id_reference_texte_unique" UNIQUE("tenant_id","reference_texte"),
	CONSTRAINT "demandes_reference_texte_format" CHECK ("demandes"."reference_texte" ~ '^demande:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
	CONSTRAINT "demandes_reference_texte_longueur" CHECK (char_length("demandes"."reference_texte") <= 64),
	CONSTRAINT "demandes_categorie_code" CHECK ("demandes"."categorie" ~ '^[a-z][a-z0-9_.-]{0,63}$'),
	CONSTRAINT "demandes_responsable_borne" CHECK ("demandes"."responsable" IS NULL OR (length(btrim("demandes"."responsable")) > 0 AND char_length("demandes"."responsable") <= 200))
);
--> statement-breakpoint
CREATE TABLE "notes" (
	"tenant_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"organisation_id" uuid NOT NULL,
	"auteur" text NOT NULL,
	"texte" text NOT NULL,
	"type" "type_note" NOT NULL,
	"cree_le" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notes_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "notes_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "notes_auteur_non_vide" CHECK (length(btrim("notes"."auteur")) > 0 AND char_length("notes"."auteur") <= 200),
	CONSTRAINT "notes_texte_non_vide" CHECK (length(btrim("notes"."texte")) > 0),
	CONSTRAINT "notes_texte_longueur" CHECK (char_length("notes"."texte") BETWEEN 1 AND 1000)
);
--> statement-breakpoint
CREATE TABLE "outils_client" (
	"tenant_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"organisation_id" uuid NOT NULL,
	"famille" "famille_connecteur" NOT NULL,
	"outil" text NOT NULL,
	"connecteur_disponible" boolean DEFAULT false NOT NULL,
	"cree_le" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outils_client_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "outils_client_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "outils_client_tenant_id_organisation_id_outil_unique" UNIQUE("tenant_id","organisation_id","outil"),
	CONSTRAINT "outils_client_outil_code" CHECK ("outils_client"."outil" ~ '^[a-z][a-z0-9_.-]{0,63}$')
);
--> statement-breakpoint
CREATE TABLE "propositions" (
	"tenant_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"organisation_id" uuid NOT NULL,
	"audit_id" uuid,
	"statut" "statut_proposition" DEFAULT 'brouillon' NOT NULL,
	"identifiant_hub" text NOT NULL,
	"nombre_paliers" integer NOT NULL,
	"cree_le" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "propositions_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "propositions_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "propositions_tenant_id_identifiant_hub_unique" UNIQUE("tenant_id","identifiant_hub"),
	CONSTRAINT "propositions_identifiant_hub_format" CHECK ("propositions"."identifiant_hub" ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$'),
	CONSTRAINT "propositions_paliers_bornes" CHECK ("propositions"."nombre_paliers" BETWEEN 1 AND 5)
);
--> statement-breakpoint
CREATE TABLE "propositions_automatisations" (
	"tenant_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"proposition_id" uuid NOT NULL,
	"automatisation_id" uuid NOT NULL,
	"palier" integer NOT NULL,
	CONSTRAINT "propositions_automatisations_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "propositions_automatisations_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "propositions_automatisations_unique" UNIQUE("tenant_id","proposition_id","automatisation_id"),
	CONSTRAINT "propositions_automatisations_palier_borne" CHECK ("propositions_automatisations"."palier" BETWEEN 1 AND 5)
);
--> statement-breakpoint
CREATE TABLE "registre_traitements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"finalite" text NOT NULL,
	"base_legale" "base_legale" NOT NULL,
	"categories_donnees" text NOT NULL,
	"destinataires" text NOT NULL,
	"duree_conservation" text NOT NULL,
	"mesures_securite" text NOT NULL,
	"cree_le" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "registre_traitements_code_unique" UNIQUE("code"),
	CONSTRAINT "registre_traitements_code_format" CHECK ("registre_traitements"."code" ~ '^[a-z][a-z0-9_.-]{0,63}$'),
	CONSTRAINT "registre_traitements_finalite_borne" CHECK (char_length("registre_traitements"."finalite") BETWEEN 1 AND 1000),
	CONSTRAINT "registre_traitements_categories_donnees_borne" CHECK (char_length("registre_traitements"."categories_donnees") BETWEEN 1 AND 1000),
	CONSTRAINT "registre_traitements_destinataires_borne" CHECK (char_length("registre_traitements"."destinataires") BETWEEN 1 AND 1000),
	CONSTRAINT "registre_traitements_duree_conservation_borne" CHECK (char_length("registre_traitements"."duree_conservation") BETWEEN 1 AND 1000),
	CONSTRAINT "registre_traitements_mesures_securite_borne" CHECK (char_length("registre_traitements"."mesures_securite") BETWEEN 1 AND 1000)
);
--> statement-breakpoint
CREATE TABLE "themes_client" (
	"tenant_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"organisation_id" uuid NOT NULL,
	"logo_ref" text,
	"couleur_principale" text DEFAULT 'couleur.action' NOT NULL,
	"couleur_accent" text DEFAULT 'couleur.teinte.vert.liseret' NOT NULL,
	"police" text DEFAULT 'police.titre' NOT NULL,
	"ton" "ton_theme" DEFAULT 'neutre' NOT NULL,
	"signature" text,
	"mentions_legales" text,
	"actif" boolean DEFAULT false NOT NULL,
	"cree_le" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "themes_client_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "themes_client_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "themes_client_logo_ref_format" CHECK ("themes_client"."logo_ref" IS NULL OR ("themes_client"."logo_ref" ~ '^[A-Za-z0-9][A-Za-z0-9_./-]{0,254}$' AND "themes_client"."logo_ref" !~ '\.\.')),
	CONSTRAINT "themes_client_couleur_principale_jeton" CHECK ("themes_client"."couleur_principale" ~ '^[a-z][a-zA-Z0-9.]{0,63}$'),
	CONSTRAINT "themes_client_couleur_accent_jeton" CHECK ("themes_client"."couleur_accent" ~ '^[a-z][a-zA-Z0-9.]{0,63}$'),
	CONSTRAINT "themes_client_police_jeton" CHECK ("themes_client"."police" ~ '^[a-z][a-zA-Z0-9.]{0,63}$'),
	CONSTRAINT "themes_client_signature_borne" CHECK ("themes_client"."signature" IS NULL OR char_length("themes_client"."signature") <= 500),
	CONSTRAINT "themes_client_mentions_bornees" CHECK ("themes_client"."mentions_legales" IS NULL OR char_length("themes_client"."mentions_legales") <= 2000)
);
--> statement-breakpoint
ALTER TABLE "audits_client" ADD CONSTRAINT "audits_client_organisation_fk" FOREIGN KEY ("tenant_id","organisation_id") REFERENCES "public"."organisations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "besoins" ADD CONSTRAINT "besoins_automatisation_id_automatisations_id_fk" FOREIGN KEY ("automatisation_id") REFERENCES "public"."automatisations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "besoins" ADD CONSTRAINT "besoins_audit_fk" FOREIGN KEY ("tenant_id","audit_id") REFERENCES "public"."audits_client"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demandes" ADD CONSTRAINT "demandes_automatisation_id_automatisations_id_fk" FOREIGN KEY ("automatisation_id") REFERENCES "public"."automatisations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demandes" ADD CONSTRAINT "demandes_organisation_fk" FOREIGN KEY ("tenant_id","organisation_id") REFERENCES "public"."organisations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_organisation_fk" FOREIGN KEY ("tenant_id","organisation_id") REFERENCES "public"."organisations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outils_client" ADD CONSTRAINT "outils_client_organisation_fk" FOREIGN KEY ("tenant_id","organisation_id") REFERENCES "public"."organisations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "propositions" ADD CONSTRAINT "propositions_organisation_fk" FOREIGN KEY ("tenant_id","organisation_id") REFERENCES "public"."organisations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "propositions" ADD CONSTRAINT "propositions_audit_fk" FOREIGN KEY ("tenant_id","audit_id") REFERENCES "public"."audits_client"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "propositions_automatisations" ADD CONSTRAINT "propositions_automatisations_automatisation_id_automatisations_id_fk" FOREIGN KEY ("automatisation_id") REFERENCES "public"."automatisations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "propositions_automatisations" ADD CONSTRAINT "propositions_automatisations_proposition_fk" FOREIGN KEY ("tenant_id","proposition_id") REFERENCES "public"."propositions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "themes_client" ADD CONSTRAINT "themes_client_organisation_fk" FOREIGN KEY ("tenant_id","organisation_id") REFERENCES "public"."organisations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audits_client_tenant_id_idx" ON "audits_client" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "besoins_tenant_id_idx" ON "besoins" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "demandes_tenant_id_idx" ON "demandes" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "notes_tenant_id_idx" ON "notes" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "outils_client_tenant_id_idx" ON "outils_client" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "propositions_tenant_id_idx" ON "propositions" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "propositions_automatisations_tenant_id_idx" ON "propositions_automatisations" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "themes_client_tenant_id_idx" ON "themes_client" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "themes_client_un_actif" ON "themes_client" USING btree ("tenant_id") WHERE "themes_client"."actif";--> statement-breakpoint
-- Partie écrite à la main (drizzle-kit ne génère ni RLS, ni droits, ni déclencheurs), dans la même migration que les tables (ADR 0044, 0055).
-- Solution la plus restrictive (ADR 0055) : aucun DELETE ni TRUNCATE, aucun droit pour PUBLIC ; UPDATE limité par colonnes (ou aucun) ; l'acteur est obligatoire à
-- chaque écriture, sans repli sur « systeme » ; la note, la proposition et ses automatisations sont en ajout seul pour l'application (la note, sauf son auteur, ne change jamais).
-- Aucune fonction nouvelle : donc aucune empreinte à déclarer dans scripts/garde-migrations-fonctions.json.
ALTER TABLE "public"."notes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."notes" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY isolation_client ON "public"."notes" FOR ALL TO console_app USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY lecture_equipe ON "public"."notes" FOR SELECT TO console_equipe USING (tenant_id IS NOT NULL);--> statement-breakpoint
REVOKE ALL ON TABLE "public"."notes" FROM PUBLIC;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "public"."notes" TO console_app;--> statement-breakpoint
CREATE POLICY auteur_insertion ON "public"."notes" AS RESTRICTIVE FOR INSERT TO console_app WITH CHECK (auteur = NULLIF(current_setting('app.acteur', true), ''));--> statement-breakpoint
CREATE POLICY acteur_obligatoire_insert ON "public"."notes" AS RESTRICTIVE FOR INSERT TO console_app WITH CHECK (NULLIF(current_setting('app.acteur', true), '') IS NOT NULL);--> statement-breakpoint
GRANT SELECT ON TABLE "public"."notes" TO console_equipe;--> statement-breakpoint
ALTER TABLE "public"."demandes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."demandes" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY isolation_client ON "public"."demandes" FOR ALL TO console_app USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY lecture_equipe ON "public"."demandes" FOR SELECT TO console_equipe USING (tenant_id IS NOT NULL);--> statement-breakpoint
REVOKE ALL ON TABLE "public"."demandes" FROM PUBLIC;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "public"."demandes" TO console_app;--> statement-breakpoint
GRANT UPDATE ("statut", "priorite", "responsable") ON TABLE "public"."demandes" TO console_app;--> statement-breakpoint
CREATE POLICY creation_demande ON "public"."demandes" AS RESTRICTIVE FOR INSERT TO console_app WITH CHECK (statut = 'nouvelle');--> statement-breakpoint
CREATE POLICY transitions_demande ON "public"."demandes" AS RESTRICTIVE FOR UPDATE TO console_app USING (tenant_id IS NOT NULL AND statut <> 'close') WITH CHECK (tenant_id IS NOT NULL);--> statement-breakpoint
CREATE POLICY acteur_obligatoire_insert ON "public"."demandes" AS RESTRICTIVE FOR INSERT TO console_app WITH CHECK (NULLIF(current_setting('app.acteur', true), '') IS NOT NULL);--> statement-breakpoint
CREATE POLICY acteur_obligatoire_update ON "public"."demandes" AS RESTRICTIVE FOR UPDATE TO console_app USING (true) WITH CHECK (NULLIF(current_setting('app.acteur', true), '') IS NOT NULL);--> statement-breakpoint
GRANT SELECT ON TABLE "public"."demandes" TO console_equipe;--> statement-breakpoint
CREATE TRIGGER demandes_audit AFTER INSERT OR UPDATE OR DELETE ON "public"."demandes" FOR EACH ROW EXECUTE FUNCTION public.audit_ecrire();--> statement-breakpoint
ALTER TABLE "public"."themes_client" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."themes_client" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY isolation_client ON "public"."themes_client" FOR ALL TO console_app USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY lecture_equipe ON "public"."themes_client" FOR SELECT TO console_equipe USING (tenant_id IS NOT NULL);--> statement-breakpoint
REVOKE ALL ON TABLE "public"."themes_client" FROM PUBLIC;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "public"."themes_client" TO console_app;--> statement-breakpoint
GRANT UPDATE ("logo_ref", "couleur_principale", "couleur_accent", "police", "ton", "signature", "mentions_legales", "actif") ON TABLE "public"."themes_client" TO console_app;--> statement-breakpoint
CREATE POLICY acteur_obligatoire_insert ON "public"."themes_client" AS RESTRICTIVE FOR INSERT TO console_app WITH CHECK (NULLIF(current_setting('app.acteur', true), '') IS NOT NULL);--> statement-breakpoint
CREATE POLICY acteur_obligatoire_update ON "public"."themes_client" AS RESTRICTIVE FOR UPDATE TO console_app USING (true) WITH CHECK (NULLIF(current_setting('app.acteur', true), '') IS NOT NULL);--> statement-breakpoint
GRANT SELECT ON TABLE "public"."themes_client" TO console_equipe;--> statement-breakpoint
CREATE TRIGGER themes_client_audit AFTER INSERT OR UPDATE OR DELETE ON "public"."themes_client" FOR EACH ROW EXECUTE FUNCTION public.audit_ecrire();--> statement-breakpoint
ALTER TABLE "public"."outils_client" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."outils_client" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY isolation_client ON "public"."outils_client" FOR ALL TO console_app USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY lecture_equipe ON "public"."outils_client" FOR SELECT TO console_equipe USING (tenant_id IS NOT NULL);--> statement-breakpoint
REVOKE ALL ON TABLE "public"."outils_client" FROM PUBLIC;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "public"."outils_client" TO console_app;--> statement-breakpoint
GRANT UPDATE ("famille", "connecteur_disponible") ON TABLE "public"."outils_client" TO console_app;--> statement-breakpoint
CREATE POLICY acteur_obligatoire_insert ON "public"."outils_client" AS RESTRICTIVE FOR INSERT TO console_app WITH CHECK (NULLIF(current_setting('app.acteur', true), '') IS NOT NULL);--> statement-breakpoint
CREATE POLICY acteur_obligatoire_update ON "public"."outils_client" AS RESTRICTIVE FOR UPDATE TO console_app USING (true) WITH CHECK (NULLIF(current_setting('app.acteur', true), '') IS NOT NULL);--> statement-breakpoint
GRANT SELECT ON TABLE "public"."outils_client" TO console_equipe;--> statement-breakpoint
CREATE TRIGGER outils_client_audit AFTER INSERT OR UPDATE OR DELETE ON "public"."outils_client" FOR EACH ROW EXECUTE FUNCTION public.audit_ecrire();--> statement-breakpoint
ALTER TABLE "public"."audits_client" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."audits_client" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY isolation_client ON "public"."audits_client" FOR ALL TO console_app USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY lecture_equipe ON "public"."audits_client" FOR SELECT TO console_equipe USING (tenant_id IS NOT NULL);--> statement-breakpoint
REVOKE ALL ON TABLE "public"."audits_client" FROM PUBLIC;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "public"."audits_client" TO console_app;--> statement-breakpoint
GRANT UPDATE ("compte_rendu_ref") ON TABLE "public"."audits_client" TO console_app;--> statement-breakpoint
CREATE POLICY acteur_obligatoire_insert ON "public"."audits_client" AS RESTRICTIVE FOR INSERT TO console_app WITH CHECK (NULLIF(current_setting('app.acteur', true), '') IS NOT NULL);--> statement-breakpoint
CREATE POLICY acteur_obligatoire_update ON "public"."audits_client" AS RESTRICTIVE FOR UPDATE TO console_app USING (true) WITH CHECK (NULLIF(current_setting('app.acteur', true), '') IS NOT NULL);--> statement-breakpoint
GRANT SELECT ON TABLE "public"."audits_client" TO console_equipe;--> statement-breakpoint
CREATE TRIGGER audits_client_audit AFTER INSERT OR UPDATE OR DELETE ON "public"."audits_client" FOR EACH ROW EXECUTE FUNCTION public.audit_ecrire();--> statement-breakpoint
ALTER TABLE "public"."besoins" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."besoins" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY isolation_client ON "public"."besoins" FOR ALL TO console_app USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY lecture_equipe ON "public"."besoins" FOR SELECT TO console_equipe USING (tenant_id IS NOT NULL);--> statement-breakpoint
REVOKE ALL ON TABLE "public"."besoins" FROM PUBLIC;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "public"."besoins" TO console_app;--> statement-breakpoint
GRANT UPDATE ("priorite", "minutes_perdues_estimees", "automatisation_id") ON TABLE "public"."besoins" TO console_app;--> statement-breakpoint
CREATE POLICY acteur_obligatoire_insert ON "public"."besoins" AS RESTRICTIVE FOR INSERT TO console_app WITH CHECK (NULLIF(current_setting('app.acteur', true), '') IS NOT NULL);--> statement-breakpoint
CREATE POLICY acteur_obligatoire_update ON "public"."besoins" AS RESTRICTIVE FOR UPDATE TO console_app USING (true) WITH CHECK (NULLIF(current_setting('app.acteur', true), '') IS NOT NULL);--> statement-breakpoint
GRANT SELECT ON TABLE "public"."besoins" TO console_equipe;--> statement-breakpoint
CREATE TRIGGER besoins_audit AFTER INSERT OR UPDATE OR DELETE ON "public"."besoins" FOR EACH ROW EXECUTE FUNCTION public.audit_ecrire();--> statement-breakpoint
ALTER TABLE "public"."propositions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."propositions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY isolation_client ON "public"."propositions" FOR ALL TO console_app USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY lecture_equipe ON "public"."propositions" FOR SELECT TO console_equipe USING (tenant_id IS NOT NULL);--> statement-breakpoint
REVOKE ALL ON TABLE "public"."propositions" FROM PUBLIC;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "public"."propositions" TO console_app;--> statement-breakpoint
GRANT UPDATE ("statut") ON TABLE "public"."propositions" TO console_app;--> statement-breakpoint
CREATE POLICY acteur_obligatoire_insert ON "public"."propositions" AS RESTRICTIVE FOR INSERT TO console_app WITH CHECK (NULLIF(current_setting('app.acteur', true), '') IS NOT NULL);--> statement-breakpoint
CREATE POLICY acteur_obligatoire_update ON "public"."propositions" AS RESTRICTIVE FOR UPDATE TO console_app USING (true) WITH CHECK (NULLIF(current_setting('app.acteur', true), '') IS NOT NULL);--> statement-breakpoint
GRANT SELECT ON TABLE "public"."propositions" TO console_equipe;--> statement-breakpoint
CREATE TRIGGER propositions_audit AFTER INSERT OR UPDATE OR DELETE ON "public"."propositions" FOR EACH ROW EXECUTE FUNCTION public.audit_ecrire();--> statement-breakpoint
ALTER TABLE "public"."propositions_automatisations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."propositions_automatisations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY isolation_client ON "public"."propositions_automatisations" FOR ALL TO console_app USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY lecture_equipe ON "public"."propositions_automatisations" FOR SELECT TO console_equipe USING (tenant_id IS NOT NULL);--> statement-breakpoint
REVOKE ALL ON TABLE "public"."propositions_automatisations" FROM PUBLIC;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "public"."propositions_automatisations" TO console_app;--> statement-breakpoint
CREATE POLICY acteur_obligatoire_insert ON "public"."propositions_automatisations" AS RESTRICTIVE FOR INSERT TO console_app WITH CHECK (NULLIF(current_setting('app.acteur', true), '') IS NOT NULL);--> statement-breakpoint
GRANT SELECT ON TABLE "public"."propositions_automatisations" TO console_equipe;--> statement-breakpoint
CREATE TRIGGER propositions_automatisations_audit AFTER INSERT OR UPDATE OR DELETE ON "public"."propositions_automatisations" FOR EACH ROW EXECUTE FUNCTION public.audit_ecrire();--> statement-breakpoint
-- Tables COMMUNES (cellules, registre des traitements) : sans tenant_id, écrites et lues par l'équipe seule (console_equipe), aucun droit pour console_app (l'adresse interne d'une cellule
-- et le registre ne sont pas pour les clients). Acteur obligatoire à l'écriture ; journal de l'équipe par audit_ecrire_equipe. Aucun DELETE.
ALTER TABLE "public"."cellules" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."cellules" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY lecture_equipe ON "public"."cellules" FOR SELECT TO console_equipe USING (true);--> statement-breakpoint
CREATE POLICY ajout_equipe ON "public"."cellules" FOR INSERT TO console_equipe WITH CHECK (true);--> statement-breakpoint
CREATE POLICY modification_equipe ON "public"."cellules" FOR UPDATE TO console_equipe USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY acteur_obligatoire_insert ON "public"."cellules" AS RESTRICTIVE FOR INSERT TO console_equipe WITH CHECK (NULLIF(current_setting('app.acteur', true), '') IS NOT NULL);--> statement-breakpoint
CREATE POLICY acteur_obligatoire_update ON "public"."cellules" AS RESTRICTIVE FOR UPDATE TO console_equipe USING (true) WITH CHECK (NULLIF(current_setting('app.acteur', true), '') IS NOT NULL);--> statement-breakpoint
REVOKE ALL ON TABLE "public"."cellules" FROM PUBLIC;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "public"."cellules" TO console_equipe;--> statement-breakpoint
GRANT UPDATE ("adresse_interne", "mode", "capacite", "nombre_instances", "version_image", "dernier_signal_le", "etat") ON TABLE "public"."cellules" TO console_equipe;--> statement-breakpoint
CREATE TRIGGER cellules_audit AFTER INSERT OR UPDATE OR DELETE ON "public"."cellules" FOR EACH ROW EXECUTE FUNCTION public.audit_ecrire_equipe();--> statement-breakpoint
ALTER TABLE "public"."registre_traitements" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."registre_traitements" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY lecture_equipe ON "public"."registre_traitements" FOR SELECT TO console_equipe USING (true);--> statement-breakpoint
CREATE POLICY ajout_equipe ON "public"."registre_traitements" FOR INSERT TO console_equipe WITH CHECK (true);--> statement-breakpoint
CREATE POLICY modification_equipe ON "public"."registre_traitements" FOR UPDATE TO console_equipe USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY acteur_obligatoire_insert ON "public"."registre_traitements" AS RESTRICTIVE FOR INSERT TO console_equipe WITH CHECK (NULLIF(current_setting('app.acteur', true), '') IS NOT NULL);--> statement-breakpoint
CREATE POLICY acteur_obligatoire_update ON "public"."registre_traitements" AS RESTRICTIVE FOR UPDATE TO console_equipe USING (true) WITH CHECK (NULLIF(current_setting('app.acteur', true), '') IS NOT NULL);--> statement-breakpoint
REVOKE ALL ON TABLE "public"."registre_traitements" FROM PUBLIC;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "public"."registre_traitements" TO console_equipe;--> statement-breakpoint
GRANT UPDATE ("finalite", "base_legale", "categories_donnees", "destinataires", "duree_conservation", "mesures_securite") ON TABLE "public"."registre_traitements" TO console_equipe;--> statement-breakpoint
CREATE TRIGGER registre_traitements_audit AFTER INSERT OR UPDATE OR DELETE ON "public"."registre_traitements" FOR EACH ROW EXECUTE FUNCTION public.audit_ecrire_equipe();
