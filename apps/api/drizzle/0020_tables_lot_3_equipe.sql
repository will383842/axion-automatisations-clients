-- T3-05a (ADR 0115) : tables de l'équipe, vues, « Aujourd'hui », colonnes de demandes et de notes. ADDITIVE. Numéro 0020 (après 0019 de T2-52a).
-- Aucune fonction nouvelle ; ni suppression, ni vidage, ni changement de type. Échec fermé : une ligne hors contrainte fait échouer la transaction entière.
CREATE TYPE "public"."motif_ignore" AS ENUM('deja_traite', 'sans_objet', 'reporte', 'autre');--> statement-breakpoint
CREATE TYPE "public"."nature_absence" AS ENUM('annoncee', 'constatee');--> statement-breakpoint
CREATE TYPE "public"."role_membre_equipe" AS ENUM('dirigeant', 'second_administrateur');--> statement-breakpoint
CREATE TYPE "public"."qualification_demande" AS ENUM('aucune', 'incident', 'violation', 'droits');--> statement-breakpoint
CREATE TABLE "absences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"membre_id" uuid NOT NULL,
	"debut" timestamp with time zone NOT NULL,
	"fin" timestamp with time zone,
	"nature" "nature_absence" NOT NULL,
	"ouverte_par" text NOT NULL,
	"fermee_par" text,
	"cree_le" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "absences_periode" CHECK ("absences"."fin" IS NULL OR "absences"."fin" > "absences"."debut"),
	CONSTRAINT "absences_fermeture" CHECK (("absences"."fin" IS NULL) = ("absences"."fermee_par" IS NULL)),
	CONSTRAINT "absences_ouverte_par_borne" CHECK (length(btrim("absences"."ouverte_par")) > 0 AND char_length("absences"."ouverte_par") <= 200),
	CONSTRAINT "absences_fermee_par_borne" CHECK ("absences"."fermee_par" IS NULL OR (length(btrim("absences"."fermee_par")) > 0 AND char_length("absences"."fermee_par") <= 200))
);
--> statement-breakpoint
CREATE TABLE "aujourdhui_ignores" (
	"tenant_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"organisation_id" uuid NOT NULL,
	"type_fait" text NOT NULL,
	"reference" text NOT NULL,
	"jour" date NOT NULL,
	"motif" "motif_ignore",
	"membre" text NOT NULL,
	"retabli_le" timestamp with time zone,
	"cree_le" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "aujourdhui_ignores_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "aujourdhui_ignores_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "aujourdhui_ignores_fait_jour_unique" UNIQUE("tenant_id","type_fait","reference","jour"),
	CONSTRAINT "aujourdhui_ignores_type_fait_code" CHECK ("aujourdhui_ignores"."type_fait" ~ '^[a-z][a-z0-9_.-]{0,63}$'),
	CONSTRAINT "aujourdhui_ignores_reference_forme" CHECK ("aujourdhui_ignores"."reference" ~ '^[A-Za-z0-9][A-Za-z0-9:_.-]{0,127}$'),
	CONSTRAINT "aujourdhui_ignores_membre_borne" CHECK (length(btrim("aujourdhui_ignores"."membre")) > 0 AND char_length("aujourdhui_ignores"."membre") <= 200)
);
--> statement-breakpoint
CREATE TABLE "membres_equipe" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sujet" text NOT NULL,
	"role" "role_membre_equipe" NOT NULL,
	"portee_clients" uuid[] DEFAULT '{}' NOT NULL,
	"portee_automatisations" uuid[] DEFAULT '{}' NOT NULL,
	"actif" boolean DEFAULT true NOT NULL,
	"desactive_le" timestamp with time zone,
	"desactive_par" text,
	"cree_le" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "membres_equipe_sujet_unique" UNIQUE("sujet"),
	CONSTRAINT "membres_equipe_sujet_forme" CHECK ("membres_equipe"."sujet" ~ '^[A-Za-z0-9][A-Za-z0-9_.@:-]{0,127}$'),
	CONSTRAINT "membres_equipe_desactivation" CHECK ("membres_equipe"."actif" = ("membres_equipe"."desactive_le" IS NULL) AND ("membres_equipe"."desactive_le" IS NULL) = ("membres_equipe"."desactive_par" IS NULL)),
	CONSTRAINT "membres_equipe_desactive_par_borne" CHECK ("membres_equipe"."desactive_par" IS NULL OR (length(btrim("membres_equipe"."desactive_par")) > 0 AND char_length("membres_equipe"."desactive_par") <= 200)),
	CONSTRAINT "membres_equipe_portees_bornees" CHECK (cardinality("membres_equipe"."portee_clients") <= 1000 AND cardinality("membres_equipe"."portee_automatisations") <= 1000)
);
--> statement-breakpoint
CREATE TABLE "vues_enregistrees" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"proprietaire_id" uuid NOT NULL,
	"ecran" text NOT NULL,
	"nom" text NOT NULL,
	"filtres" jsonb NOT NULL,
	"version_schema" smallint DEFAULT 1 NOT NULL,
	"cree_le" timestamp with time zone DEFAULT now() NOT NULL,
	"modifiee_le" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vues_enregistrees_proprietaire_nom_unique" UNIQUE("proprietaire_id","ecran","nom"),
	CONSTRAINT "vues_enregistrees_ecran_code" CHECK ("vues_enregistrees"."ecran" ~ '^[a-z][a-z0-9_.-]{0,63}$'),
	CONSTRAINT "vues_enregistrees_nom_borne" CHECK (length(btrim("vues_enregistrees"."nom")) > 0 AND char_length("vues_enregistrees"."nom") <= 80),
	CONSTRAINT "vues_enregistrees_filtres_objet" CHECK (jsonb_typeof("vues_enregistrees"."filtres") = 'object' AND octet_length("vues_enregistrees"."filtres"::text) <= 4000),
	CONSTRAINT "vues_enregistrees_version_positive" CHECK ("vues_enregistrees"."version_schema" >= 1)
);
--> statement-breakpoint
ALTER TABLE "demandes" ADD COLUMN "echeance_prise_en_charge" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "demandes" ADD COLUMN "qualification" "qualification_demande" DEFAULT 'aucune' NOT NULL;--> statement-breakpoint
ALTER TABLE "demandes" ADD COLUMN "satisfaction" smallint;--> statement-breakpoint
ALTER TABLE "demandes" ADD COLUMN "close_le" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "notes" ADD COLUMN "epinglee" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "absences" ADD CONSTRAINT "absences_membre_id_membres_equipe_id_fk" FOREIGN KEY ("membre_id") REFERENCES "public"."membres_equipe"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "aujourdhui_ignores" ADD CONSTRAINT "aujourdhui_ignores_organisation_fk" FOREIGN KEY ("tenant_id","organisation_id") REFERENCES "public"."organisations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vues_enregistrees" ADD CONSTRAINT "vues_enregistrees_proprietaire_id_membres_equipe_id_fk" FOREIGN KEY ("proprietaire_id") REFERENCES "public"."membres_equipe"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "absences_une_ouverte_par_membre" ON "absences" USING btree ("membre_id") WHERE "absences"."fin" IS NULL;--> statement-breakpoint
CREATE INDEX "absences_membre_debut_idx" ON "absences" USING btree ("membre_id","debut");--> statement-breakpoint
CREATE INDEX "aujourdhui_ignores_tenant_id_idx" ON "aujourdhui_ignores" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "aujourdhui_ignores_jour_idx" ON "aujourdhui_ignores" USING btree ("tenant_id","jour");--> statement-breakpoint
CREATE INDEX "demandes_echeance_idx" ON "demandes" USING btree ("tenant_id","echeance_prise_en_charge") WHERE "demandes"."close_le" IS NULL;--> statement-breakpoint
ALTER TABLE "demandes" ADD CONSTRAINT "demandes_satisfaction_intervalle" CHECK ("demandes"."satisfaction" IS NULL OR "demandes"."satisfaction" BETWEEN 1 AND 5);--> statement-breakpoint
-- close_le : ajoutée sans balayage puis validée (les lignes existantes ont close_le nul : la validation passe ; sinon la migration échoue et rien ne change).
ALTER TABLE "demandes" ADD CONSTRAINT "demandes_close_le_statut" CHECK ("demandes"."close_le" IS NULL OR "demandes"."statut" IN ('resolue', 'close')) NOT VALID;--> statement-breakpoint
ALTER TABLE "demandes" VALIDATE CONSTRAINT "demandes_close_le_statut";--> statement-breakpoint

-- ===== Partie écrite à la main (drizzle-kit ne génère ni RLS, ni droits, ni déclencheurs). Aucune fonction nouvelle. =====
-- Tables COMMUNES de l'équipe : RLS + FORCE, console_equipe seul, acteur obligatoire, journal de l'équipe, aucun DELETE, aucun droit pour console_app.
ALTER TABLE "public"."membres_equipe" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."membres_equipe" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY lecture_equipe ON "public"."membres_equipe" FOR SELECT TO console_equipe USING (true);--> statement-breakpoint
CREATE POLICY ajout_equipe ON "public"."membres_equipe" FOR INSERT TO console_equipe WITH CHECK (true);--> statement-breakpoint
CREATE POLICY modification_equipe ON "public"."membres_equipe" FOR UPDATE TO console_equipe USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY acteur_obligatoire_insert ON "public"."membres_equipe" AS RESTRICTIVE FOR INSERT TO console_equipe WITH CHECK (NULLIF(current_setting('app.acteur', true), '') IS NOT NULL);--> statement-breakpoint
-- Réactivation interdite en V1 (choix le plus restrictif, point F2) : une ligne désactivée ne se modifie plus.
CREATE POLICY acteur_obligatoire_update ON "public"."membres_equipe" AS RESTRICTIVE FOR UPDATE TO console_equipe USING (actif) WITH CHECK (NULLIF(current_setting('app.acteur', true), '') IS NOT NULL);--> statement-breakpoint
REVOKE ALL ON TABLE "public"."membres_equipe" FROM PUBLIC;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "public"."membres_equipe" TO console_equipe;--> statement-breakpoint
GRANT UPDATE ("role", "portee_clients", "portee_automatisations", "actif", "desactive_le", "desactive_par") ON TABLE "public"."membres_equipe" TO console_equipe;--> statement-breakpoint
CREATE TRIGGER membres_equipe_audit AFTER INSERT OR UPDATE OR DELETE ON "public"."membres_equipe" FOR EACH ROW EXECUTE FUNCTION public.audit_ecrire_equipe();--> statement-breakpoint

ALTER TABLE "public"."absences" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."absences" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY lecture_equipe ON "public"."absences" FOR SELECT TO console_equipe USING (true);--> statement-breakpoint
CREATE POLICY ajout_equipe ON "public"."absences" FOR INSERT TO console_equipe WITH CHECK (true);--> statement-breakpoint
CREATE POLICY modification_equipe ON "public"."absences" FOR UPDATE TO console_equipe USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY ouverte_par_acteur ON "public"."absences" AS RESTRICTIVE FOR INSERT TO console_equipe WITH CHECK (ouverte_par = NULLIF(current_setting('app.acteur', true), '') AND fin IS NULL);--> statement-breakpoint
-- Une absence fermée ne se rouvre pas et ne se réécrit pas ; la ferme qui est l'acteur (qui peut fermer : règle de l'API, T3-00 point 2b).
CREATE POLICY fermeture_acteur ON "public"."absences" AS RESTRICTIVE FOR UPDATE TO console_equipe USING (fin IS NULL) WITH CHECK (fermee_par = NULLIF(current_setting('app.acteur', true), ''));--> statement-breakpoint
REVOKE ALL ON TABLE "public"."absences" FROM PUBLIC;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "public"."absences" TO console_equipe;--> statement-breakpoint
GRANT UPDATE ("fin", "fermee_par") ON TABLE "public"."absences" TO console_equipe;--> statement-breakpoint
CREATE TRIGGER absences_audit AFTER INSERT OR UPDATE OR DELETE ON "public"."absences" FOR EACH ROW EXECUTE FUNCTION public.audit_ecrire_equipe();--> statement-breakpoint

ALTER TABLE "public"."vues_enregistrees" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."vues_enregistrees" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- Non partagée en V1 : chaque membre ne voit et n'écrit que ses vues (sujet = app.acteur, point F7).
CREATE POLICY vues_du_proprietaire ON "public"."vues_enregistrees" FOR ALL TO console_equipe
  USING (proprietaire_id IN (SELECT m.id FROM public.membres_equipe m WHERE m.sujet = NULLIF(current_setting('app.acteur', true), '') AND m.actif))
  WITH CHECK (proprietaire_id IN (SELECT m.id FROM public.membres_equipe m WHERE m.sujet = NULLIF(current_setting('app.acteur', true), '') AND m.actif));--> statement-breakpoint
REVOKE ALL ON TABLE "public"."vues_enregistrees" FROM PUBLIC;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "public"."vues_enregistrees" TO console_equipe;--> statement-breakpoint
GRANT UPDATE ("nom", "filtres", "version_schema", "modifiee_le") ON TABLE "public"."vues_enregistrees" TO console_equipe;--> statement-breakpoint
CREATE TRIGGER vues_enregistrees_audit AFTER INSERT OR UPDATE OR DELETE ON "public"."vues_enregistrees" FOR EACH ROW EXECUTE FUNCTION public.audit_ecrire_equipe();--> statement-breakpoint

-- Table PAR CLIENT (modèle ops/socle/postgres/modele-politique-rls.sql).
ALTER TABLE "public"."aujourdhui_ignores" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."aujourdhui_ignores" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY isolation_client ON "public"."aujourdhui_ignores" FOR ALL TO console_app USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY lecture_equipe ON "public"."aujourdhui_ignores" FOR SELECT TO console_equipe USING (tenant_id IS NOT NULL);--> statement-breakpoint
CREATE POLICY membre_insertion ON "public"."aujourdhui_ignores" AS RESTRICTIVE FOR INSERT TO console_app WITH CHECK (membre = NULLIF(current_setting('app.acteur', true), '') AND retabli_le IS NULL);--> statement-breakpoint
CREATE POLICY retablir_une_fois ON "public"."aujourdhui_ignores" AS RESTRICTIVE FOR UPDATE TO console_app USING (retabli_le IS NULL) WITH CHECK (NULLIF(current_setting('app.acteur', true), '') IS NOT NULL);--> statement-breakpoint
REVOKE ALL ON TABLE "public"."aujourdhui_ignores" FROM PUBLIC;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "public"."aujourdhui_ignores" TO console_app;--> statement-breakpoint
GRANT UPDATE ("retabli_le") ON TABLE "public"."aujourdhui_ignores" TO console_app;--> statement-breakpoint
GRANT SELECT ON TABLE "public"."aujourdhui_ignores" TO console_equipe;--> statement-breakpoint
CREATE TRIGGER aujourdhui_ignores_audit AFTER INSERT OR UPDATE OR DELETE ON "public"."aujourdhui_ignores" FOR EACH ROW EXECUTE FUNCTION public.audit_ecrire();--> statement-breakpoint

-- Droits par colonne des colonnes ajoutées (les politiques restrictives existantes de demandes s'appliquent : rien sur une demande close).
GRANT UPDATE ("echeance_prise_en_charge", "qualification", "satisfaction", "close_le") ON TABLE "public"."demandes" TO console_app;--> statement-breakpoint
-- notes : seule « épinglée » change ; acteur obligatoire (les notes n'avaient aucun UPDATE : ouverture étroite, point F5).
GRANT UPDATE ("epinglee") ON TABLE "public"."notes" TO console_app;--> statement-breakpoint
CREATE POLICY acteur_obligatoire_update ON "public"."notes" AS RESTRICTIVE FOR UPDATE TO console_app USING (true) WITH CHECK (NULLIF(current_setting('app.acteur', true), '') IS NOT NULL);
-- Retour arrière (à la main, jamais par une migration) : REVOKE des droits ajoutés. Tables, colonnes, index et contraintes RESTENT.
