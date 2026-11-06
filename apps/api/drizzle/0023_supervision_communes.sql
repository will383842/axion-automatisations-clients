-- T5-01b (ADR 0116) : tables communes de la supervision, incidents_instances et commentaires_alertes par client, mesures_capacite partitionnée, quatre colonnes d'alertes. ADDITIVE : aucun DROP, DELETE, TRUNCATE, RENAME ni changement de type. Numéro 0023 (après 0022, T5-01a).
-- Échec fermé : une seule transaction ; les GRANT et politiques de console_lecture échouent si le rôle n'existe pas (créé par T5-01-ops, init/02-roles.sql). Aucun droit DELETE ni TRUNCATE nulle part.
-- mesures_capacite n'est PAS partitionnée (ESCALADE, ADR 0116) : le contrôle C5 refuse les partitions d'une table commune. Aucune fonction nouvelle dans cette migration.
-- Dette M3 de l'audit de la 0022 : liens_retour.attributs_trouves reçoit sa borne de forme, en ajout seul (NOT VALID : les lignes existantes ne sont pas relues, les nouvelles le sont).
CREATE TYPE "public"."etat_avis" AS ENUM('a_lire', 'planifie', 'traite');--> statement-breakpoint
CREATE TYPE "public"."etat_incident" AS ENUM('ouvert', 'pris_en_charge', 'resolu', 'clos');--> statement-breakpoint
CREATE TYPE "public"."gravite_incident" AS ENUM('mineure', 'majeure', 'critique');--> statement-breakpoint
CREATE TYPE "public"."portee_disjoncteur" AS ENUM('automatisation', 'version', 'connecteur', 'cellule', 'envois_instance', 'envois_plateforme');--> statement-breakpoint
CREATE TYPE "public"."type_cible_capacite" AS ENUM('serveur', 'cellule');--> statement-breakpoint
CREATE TABLE "avis_depreciation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fournisseur" text NOT NULL,
	"sujet" text NOT NULL,
	"echeance" date NOT NULL,
	"etat" "etat_avis" DEFAULT 'a_lire' NOT NULL,
	"cree_le" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "avis_depreciation_unique" UNIQUE("fournisseur","sujet","echeance"),
	CONSTRAINT "avis_depreciation_fournisseur_code" CHECK ("avis_depreciation"."fournisseur" ~ '^[a-z][a-z0-9_.-]{0,63}$'),
	CONSTRAINT "avis_depreciation_sujet_code" CHECK ("avis_depreciation"."sujet" ~ '^[a-z][a-z0-9_.-]{0,63}$')
);
--> statement-breakpoint
CREATE TABLE "bilans_incident" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"incident_id" uuid NOT NULL,
	"reference_document" text NOT NULL,
	"redige_par" text NOT NULL,
	"redige_le" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bilans_incident_incident_unique" UNIQUE("incident_id"),
	CONSTRAINT "bilans_incident_reference_forme" CHECK ("bilans_incident"."reference_document" ~ '^[A-Za-z0-9][A-Za-z0-9_./-]{0,254}$' AND "bilans_incident"."reference_document" !~ '\.\.'),
	CONSTRAINT "bilans_incident_redige_par_borne" CHECK (length(btrim("bilans_incident"."redige_par")) > 0 AND char_length("bilans_incident"."redige_par") <= 200)
);
--> statement-breakpoint
CREATE TABLE "commentaires_alertes" (
	"tenant_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"alerte_id" uuid NOT NULL,
	"auteur" text NOT NULL,
	"texte" text NOT NULL,
	"cree_le" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "commentaires_alertes_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "commentaires_alertes_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "commentaires_alertes_auteur_borne" CHECK (length(btrim("commentaires_alertes"."auteur")) > 0 AND char_length("commentaires_alertes"."auteur") <= 200),
	CONSTRAINT "commentaires_alertes_texte_borne" CHECK (length(btrim("commentaires_alertes"."texte")) > 0 AND char_length("commentaires_alertes"."texte") <= 500)
);
--> statement-breakpoint
CREATE TABLE "disjoncteurs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"portee" "portee_disjoncteur" NOT NULL,
	"cible" uuid,
	"motif_code" text NOT NULL,
	"pose_par" text NOT NULL,
	"pose_le" timestamp with time zone DEFAULT now() NOT NULL,
	"leve_par" text,
	"leve_le" timestamp with time zone,
	"rappel_le" timestamp with time zone,
	CONSTRAINT "disjoncteurs_cible_selon_portee" CHECK (("disjoncteurs"."portee" = 'envois_plateforme') = ("disjoncteurs"."cible" IS NULL)),
	CONSTRAINT "disjoncteurs_motif_code" CHECK ("disjoncteurs"."motif_code" ~ '^[a-z][a-z0-9_.-]{0,63}$'),
	CONSTRAINT "disjoncteurs_pose_par_borne" CHECK (length(btrim("disjoncteurs"."pose_par")) > 0 AND char_length("disjoncteurs"."pose_par") <= 200),
	CONSTRAINT "disjoncteurs_levee_coherente" CHECK (("disjoncteurs"."leve_le" IS NULL) = ("disjoncteurs"."leve_par" IS NULL) AND ("disjoncteurs"."leve_par" IS NULL OR length(btrim("disjoncteurs"."leve_par")) > 0 AND char_length("disjoncteurs"."leve_par") <= 200)),
	CONSTRAINT "disjoncteurs_chronologie" CHECK ("disjoncteurs"."leve_le" IS NULL OR "disjoncteurs"."leve_le" >= "disjoncteurs"."pose_le")
);
--> statement-breakpoint
CREATE TABLE "fenetres_maintenance" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"debut" timestamp with time zone NOT NULL,
	"fin" timestamp with time zone NOT NULL,
	"portee" "portee_disjoncteur" NOT NULL,
	"cible_code" text,
	"annoncee_le" timestamp with time zone,
	"auteur" text NOT NULL,
	CONSTRAINT "fenetres_maintenance_periode" CHECK ("fenetres_maintenance"."fin" > "fenetres_maintenance"."debut"),
	CONSTRAINT "fenetres_maintenance_cible_code" CHECK ("fenetres_maintenance"."cible_code" IS NULL OR "fenetres_maintenance"."cible_code" ~ '^[a-z][a-z0-9_.-]{0,63}$'),
	CONSTRAINT "fenetres_maintenance_auteur_borne" CHECK (length(btrim("fenetres_maintenance"."auteur")) > 0 AND char_length("fenetres_maintenance"."auteur") <= 200)
);
--> statement-breakpoint
CREATE TABLE "incidents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cause" text NOT NULL,
	"gravite" "gravite_incident" NOT NULL,
	"etat" "etat_incident" DEFAULT 'ouvert' NOT NULL,
	"debut" timestamp with time zone NOT NULL,
	"detecte_le" timestamp with time zone NOT NULL,
	"pris_en_charge_le" timestamp with time zone,
	"resolu_le" timestamp with time zone,
	"perimetre" "portee_disjoncteur"[] DEFAULT '{}' NOT NULL,
	CONSTRAINT "incidents_cause_code" CHECK ("incidents"."cause" ~ '^[a-z][a-z0-9_.-]{0,63}$'),
	CONSTRAINT "incidents_chronologie" CHECK ("incidents"."detecte_le" >= "incidents"."debut" AND ("incidents"."pris_en_charge_le" IS NULL OR "incidents"."pris_en_charge_le" >= "incidents"."detecte_le") AND ("incidents"."resolu_le" IS NULL OR "incidents"."resolu_le" >= "incidents"."debut")),
	CONSTRAINT "incidents_perimetre_borne" CHECK (cardinality("incidents"."perimetre") <= 6)
);
--> statement-breakpoint
CREATE TABLE "incidents_instances" (
	"tenant_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"incident_id" uuid NOT NULL,
	"instance_id" uuid NOT NULL,
	"cree_le" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "incidents_instances_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "incidents_instances_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "incidents_instances_lien_unique" UNIQUE("tenant_id","incident_id","instance_id")
);
--> statement-breakpoint
CREATE TABLE "mesures_capacite" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"debut" timestamp with time zone NOT NULL,
	"cible_type" "type_cible_capacite" NOT NULL,
	"cible_code" text NOT NULL,
	"cpu_bps" integer NOT NULL,
	"memoire_octets" bigint NOT NULL,
	"disque_octets" bigint NOT NULL,
	CONSTRAINT "mesures_capacite_cible_code" CHECK ("mesures_capacite"."cible_code" ~ '^[a-z][a-z0-9_.-]{0,63}$'),
	CONSTRAINT "mesures_capacite_valeurs" CHECK ("mesures_capacite"."cpu_bps" BETWEEN 0 AND 10000 AND "mesures_capacite"."memoire_octets" >= 0 AND "mesures_capacite"."disque_octets" >= 0)
);
--> statement-breakpoint
CREATE TABLE "modeles_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cle" text NOT NULL,
	"version" integer NOT NULL,
	"texte" text NOT NULL,
	"cree_par" text NOT NULL,
	"cree_le" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "modeles_messages_cle_version_unique" UNIQUE("cle","version"),
	CONSTRAINT "modeles_messages_cle_code" CHECK ("modeles_messages"."cle" ~ '^[a-z][a-z0-9_.-]{0,63}$'),
	CONSTRAINT "modeles_messages_version_positive" CHECK ("modeles_messages"."version" >= 1),
	CONSTRAINT "modeles_messages_texte_borne" CHECK (length(btrim("modeles_messages"."texte")) > 0 AND char_length("modeles_messages"."texte") <= 4000),
	CONSTRAINT "modeles_messages_cree_par_borne" CHECK (length(btrim("modeles_messages"."cree_par")) > 0 AND char_length("modeles_messages"."cree_par") <= 200)
);
--> statement-breakpoint
CREATE TABLE "regles_alertes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"gravite" "gravite_alerte" NOT NULL,
	"seuil" integer NOT NULL,
	"fenetre_s" integer NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"cree_le" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "regles_alertes_code_unique" UNIQUE("code"),
	CONSTRAINT "regles_alertes_code_forme" CHECK ("regles_alertes"."code" ~ '^[a-z][a-z0-9_.-]{0,63}$'),
	CONSTRAINT "regles_alertes_valeurs" CHECK ("regles_alertes"."seuil" >= 0 AND "regles_alertes"."fenetre_s" > 0)
);
--> statement-breakpoint
CREATE TABLE "reveils" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"heure" timestamp with time zone NOT NULL,
	"cause" text NOT NULL,
	"duree_s" integer NOT NULL,
	"justification" text NOT NULL,
	"auteur" text NOT NULL,
	CONSTRAINT "reveils_cause_code" CHECK ("reveils"."cause" ~ '^[a-z][a-z0-9_.-]{0,63}$'),
	CONSTRAINT "reveils_duree_positive" CHECK ("reveils"."duree_s" >= 0),
	CONSTRAINT "reveils_justification_borne" CHECK (length(btrim("reveils"."justification")) > 0 AND char_length("reveils"."justification") <= 500),
	CONSTRAINT "reveils_auteur_borne" CHECK (length(btrim("reveils"."auteur")) > 0 AND char_length("reveils"."auteur") <= 200)
);
--> statement-breakpoint
ALTER TABLE "alertes" ADD COLUMN "cle_regroupement" text;--> statement-breakpoint
ALTER TABLE "alertes" ADD COLUMN "cause" text;--> statement-breakpoint
ALTER TABLE "alertes" ADD COLUMN "incident_id" uuid;--> statement-breakpoint
ALTER TABLE "alertes" ADD COLUMN "derniere_relance" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bilans_incident" ADD CONSTRAINT "bilans_incident_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commentaires_alertes" ADD CONSTRAINT "commentaires_alertes_alerte_fk" FOREIGN KEY ("tenant_id","alerte_id") REFERENCES "public"."alertes"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents_instances" ADD CONSTRAINT "incidents_instances_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents_instances" ADD CONSTRAINT "incidents_instances_instance_fk" FOREIGN KEY ("tenant_id","instance_id") REFERENCES "public"."instances"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "commentaires_alertes_tenant_id_idx" ON "commentaires_alertes" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "disjoncteurs_un_actif_par_cible" ON "disjoncteurs" USING btree ("portee","cible") WHERE "disjoncteurs"."leve_le" IS NULL AND "disjoncteurs"."cible" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "disjoncteurs_un_actif_plateforme" ON "disjoncteurs" USING btree ("portee") WHERE "disjoncteurs"."leve_le" IS NULL AND "disjoncteurs"."cible" IS NULL;--> statement-breakpoint
CREATE INDEX "incidents_instances_tenant_id_idx" ON "incidents_instances" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "mesures_capacite_cible_debut_idx" ON "mesures_capacite" USING btree ("cible_code","debut");--> statement-breakpoint
ALTER TABLE "alertes" ADD CONSTRAINT "alertes_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "alertes_regroupement_idx" ON "alertes" USING btree ("tenant_id","cle_regroupement") WHERE "alertes"."etat" = 'ouverte';--> statement-breakpoint
ALTER TABLE "alertes" ADD CONSTRAINT "alertes_cle_regroupement_code" CHECK ("alertes"."cle_regroupement" IS NULL OR "alertes"."cle_regroupement" ~ '^[a-z0-9][a-z0-9_.:-]{0,127}$');--> statement-breakpoint
ALTER TABLE "alertes" ADD CONSTRAINT "alertes_cause_code" CHECK ("alertes"."cause" IS NULL OR "alertes"."cause" ~ '^[a-z][a-z0-9_.-]{0,63}$');--> statement-breakpoint
ALTER TABLE "liens_retour" ADD CONSTRAINT "liens_retour_attributs_codes" CHECK (array_to_string("liens_retour"."attributs_trouves", ',') ~ '^([a-z][a-z0-9_.-]{0,63}(,[a-z][a-z0-9_.-]{0,63})*)?$') NOT VALID;--> statement-breakpoint

-- ===== Partie écrite à la main : RLS activée ET forcée, droits les plus restrictifs (aucun DELETE ni TRUNCATE), acteur obligatoire, journal d'audit =====
-- Deux tables PAR CLIENT (modèle RLS de tableClient()).
ALTER TABLE "public"."incidents_instances" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."incidents_instances" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "public"."incidents_instances" FROM PUBLIC;--> statement-breakpoint
CREATE POLICY isolation_client ON "public"."incidents_instances" FOR ALL TO console_app USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY lecture_equipe ON "public"."incidents_instances" FOR SELECT TO console_equipe USING (tenant_id IS NOT NULL);--> statement-breakpoint
CREATE POLICY ajout_equipe ON "public"."incidents_instances" FOR INSERT TO console_equipe WITH CHECK (tenant_id IS NOT NULL);--> statement-breakpoint
CREATE POLICY acteur_obligatoire_insert ON "public"."incidents_instances" AS RESTRICTIVE FOR INSERT TO console_equipe WITH CHECK (NULLIF(current_setting('app.acteur', true), '') IS NOT NULL);--> statement-breakpoint
GRANT SELECT ON TABLE "public"."incidents_instances" TO console_app;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "public"."incidents_instances" TO console_equipe;--> statement-breakpoint
CREATE TRIGGER incidents_instances_audit AFTER INSERT OR UPDATE OR DELETE ON "public"."incidents_instances" FOR EACH ROW EXECUTE FUNCTION public.audit_ecrire_equipe();--> statement-breakpoint
ALTER TABLE "public"."commentaires_alertes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."commentaires_alertes" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "public"."commentaires_alertes" FROM PUBLIC;--> statement-breakpoint
CREATE POLICY isolation_client ON "public"."commentaires_alertes" FOR ALL TO console_app USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY lecture_equipe ON "public"."commentaires_alertes" FOR SELECT TO console_equipe USING (tenant_id IS NOT NULL);--> statement-breakpoint
CREATE POLICY acteur_obligatoire_insert ON "public"."commentaires_alertes" AS RESTRICTIVE FOR INSERT TO console_app WITH CHECK (NULLIF(current_setting('app.acteur', true), '') IS NOT NULL AND auteur = NULLIF(current_setting('app.acteur', true), ''));--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "public"."commentaires_alertes" TO console_app;--> statement-breakpoint
GRANT SELECT ON TABLE "public"."commentaires_alertes" TO console_equipe;--> statement-breakpoint
CREATE TRIGGER commentaires_alertes_audit AFTER INSERT OR UPDATE OR DELETE ON "public"."commentaires_alertes" FOR EACH ROW EXECUTE FUNCTION public.audit_ecrire();--> statement-breakpoint
-- console_lecture (A-188) : lecture seule, RLS appliquée comme console_app, sur les deux tables par client de la 0023 seulement. Aucune table commune.
CREATE POLICY isolation_lecture ON "public"."incidents_instances" FOR SELECT TO console_lecture USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT ON TABLE "public"."incidents_instances" TO console_lecture;--> statement-breakpoint
CREATE POLICY isolation_lecture ON "public"."commentaires_alertes" FOR SELECT TO console_lecture USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT ON TABLE "public"."commentaires_alertes" TO console_lecture;--> statement-breakpoint
-- alertes : quatre colonnes de plus, modifiables par console_app (le regroupement et la cause ne changent ni le type, ni la gravité, ni l'organisation). Les politiques de la 0010 (transitions_alerte) restent en place.
GRANT UPDATE ("cle_regroupement", "cause", "incident_id", "derniere_relance") ON TABLE "public"."alertes" TO console_app;--> statement-breakpoint
-- Neuf tables COMMUNES (aucun tenant_id) : console_equipe écrit seul, l'acteur est obligatoire, jamais de DELETE. console_app lit (lecture_catalogue) SAUF disjoncteurs et reveils : aucun droit, pas même SELECT.
-- incidents
ALTER TABLE "public"."incidents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."incidents" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "public"."incidents" FROM PUBLIC;--> statement-breakpoint
CREATE POLICY lecture_catalogue ON "public"."incidents" FOR SELECT TO console_app USING (true);--> statement-breakpoint
CREATE POLICY lecture_equipe ON "public"."incidents" FOR SELECT TO console_equipe USING (true);--> statement-breakpoint
CREATE POLICY ajout_equipe ON "public"."incidents" FOR INSERT TO console_equipe WITH CHECK (true);--> statement-breakpoint
CREATE POLICY acteur_obligatoire_insert ON "public"."incidents" AS RESTRICTIVE FOR INSERT TO console_equipe WITH CHECK (NULLIF(current_setting('app.acteur', true), '') IS NOT NULL);--> statement-breakpoint
CREATE POLICY modification_equipe ON "public"."incidents" FOR UPDATE TO console_equipe USING (etat <> 'clos') WITH CHECK (true);--> statement-breakpoint
CREATE POLICY acteur_obligatoire_update ON "public"."incidents" AS RESTRICTIVE FOR UPDATE TO console_equipe USING (true) WITH CHECK (NULLIF(current_setting('app.acteur', true), '') IS NOT NULL);--> statement-breakpoint
GRANT SELECT ON TABLE "public"."incidents" TO console_app;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "public"."incidents" TO console_equipe;--> statement-breakpoint
GRANT UPDATE ("gravite", "etat", "pris_en_charge_le", "resolu_le", "perimetre") ON TABLE "public"."incidents" TO console_equipe;--> statement-breakpoint
CREATE TRIGGER incidents_audit AFTER INSERT OR UPDATE OR DELETE ON "public"."incidents" FOR EACH ROW EXECUTE FUNCTION public.audit_ecrire_equipe();--> statement-breakpoint
-- regles_alertes
ALTER TABLE "public"."regles_alertes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."regles_alertes" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "public"."regles_alertes" FROM PUBLIC;--> statement-breakpoint
CREATE POLICY lecture_catalogue ON "public"."regles_alertes" FOR SELECT TO console_app USING (true);--> statement-breakpoint
CREATE POLICY lecture_equipe ON "public"."regles_alertes" FOR SELECT TO console_equipe USING (true);--> statement-breakpoint
CREATE POLICY ajout_equipe ON "public"."regles_alertes" FOR INSERT TO console_equipe WITH CHECK (true);--> statement-breakpoint
CREATE POLICY acteur_obligatoire_insert ON "public"."regles_alertes" AS RESTRICTIVE FOR INSERT TO console_equipe WITH CHECK (NULLIF(current_setting('app.acteur', true), '') IS NOT NULL);--> statement-breakpoint
CREATE POLICY modification_equipe ON "public"."regles_alertes" FOR UPDATE TO console_equipe USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY acteur_obligatoire_update ON "public"."regles_alertes" AS RESTRICTIVE FOR UPDATE TO console_equipe USING (true) WITH CHECK (NULLIF(current_setting('app.acteur', true), '') IS NOT NULL);--> statement-breakpoint
GRANT SELECT ON TABLE "public"."regles_alertes" TO console_app;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "public"."regles_alertes" TO console_equipe;--> statement-breakpoint
GRANT UPDATE ("gravite", "seuil", "fenetre_s", "active") ON TABLE "public"."regles_alertes" TO console_equipe;--> statement-breakpoint
CREATE TRIGGER regles_alertes_audit AFTER INSERT OR UPDATE OR DELETE ON "public"."regles_alertes" FOR EACH ROW EXECUTE FUNCTION public.audit_ecrire_equipe();--> statement-breakpoint
-- disjoncteurs
ALTER TABLE "public"."disjoncteurs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."disjoncteurs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "public"."disjoncteurs" FROM PUBLIC;--> statement-breakpoint
CREATE POLICY lecture_equipe ON "public"."disjoncteurs" FOR SELECT TO console_equipe USING (true);--> statement-breakpoint
CREATE POLICY ajout_equipe ON "public"."disjoncteurs" FOR INSERT TO console_equipe WITH CHECK (true);--> statement-breakpoint
CREATE POLICY acteur_obligatoire_insert ON "public"."disjoncteurs" AS RESTRICTIVE FOR INSERT TO console_equipe WITH CHECK (NULLIF(current_setting('app.acteur', true), '') IS NOT NULL AND pose_par = NULLIF(current_setting('app.acteur', true), ''));--> statement-breakpoint
CREATE POLICY modification_equipe ON "public"."disjoncteurs" FOR UPDATE TO console_equipe USING (leve_le IS NULL) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY acteur_obligatoire_update ON "public"."disjoncteurs" AS RESTRICTIVE FOR UPDATE TO console_equipe USING (true) WITH CHECK (NULLIF(current_setting('app.acteur', true), '') IS NOT NULL AND (leve_par IS NULL OR leve_par = NULLIF(current_setting('app.acteur', true), '')));--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "public"."disjoncteurs" TO console_equipe;--> statement-breakpoint
GRANT UPDATE ("leve_par", "leve_le", "rappel_le") ON TABLE "public"."disjoncteurs" TO console_equipe;--> statement-breakpoint
CREATE TRIGGER disjoncteurs_audit AFTER INSERT OR UPDATE OR DELETE ON "public"."disjoncteurs" FOR EACH ROW EXECUTE FUNCTION public.audit_ecrire_equipe();--> statement-breakpoint
-- reveils
ALTER TABLE "public"."reveils" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."reveils" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "public"."reveils" FROM PUBLIC;--> statement-breakpoint
CREATE POLICY lecture_equipe ON "public"."reveils" FOR SELECT TO console_equipe USING (true);--> statement-breakpoint
CREATE POLICY ajout_equipe ON "public"."reveils" FOR INSERT TO console_equipe WITH CHECK (true);--> statement-breakpoint
CREATE POLICY acteur_obligatoire_insert ON "public"."reveils" AS RESTRICTIVE FOR INSERT TO console_equipe WITH CHECK (NULLIF(current_setting('app.acteur', true), '') IS NOT NULL AND auteur = NULLIF(current_setting('app.acteur', true), ''));--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "public"."reveils" TO console_equipe;--> statement-breakpoint
CREATE TRIGGER reveils_audit AFTER INSERT OR UPDATE OR DELETE ON "public"."reveils" FOR EACH ROW EXECUTE FUNCTION public.audit_ecrire_equipe();--> statement-breakpoint
-- mesures_capacite (table commune non partitionnée)
ALTER TABLE "public"."mesures_capacite" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."mesures_capacite" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "public"."mesures_capacite" FROM PUBLIC;--> statement-breakpoint
CREATE POLICY lecture_catalogue ON "public"."mesures_capacite" FOR SELECT TO console_app USING (true);--> statement-breakpoint
CREATE POLICY lecture_equipe ON "public"."mesures_capacite" FOR SELECT TO console_equipe USING (true);--> statement-breakpoint
CREATE POLICY ajout_equipe ON "public"."mesures_capacite" FOR INSERT TO console_equipe WITH CHECK (true);--> statement-breakpoint
CREATE POLICY acteur_obligatoire_insert ON "public"."mesures_capacite" AS RESTRICTIVE FOR INSERT TO console_equipe WITH CHECK (NULLIF(current_setting('app.acteur', true), '') IS NOT NULL);--> statement-breakpoint
GRANT SELECT ON TABLE "public"."mesures_capacite" TO console_app;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "public"."mesures_capacite" TO console_equipe;--> statement-breakpoint
CREATE TRIGGER mesures_capacite_audit AFTER INSERT OR UPDATE OR DELETE ON "public"."mesures_capacite" FOR EACH ROW EXECUTE FUNCTION public.audit_ecrire_equipe();--> statement-breakpoint
-- modeles_messages
ALTER TABLE "public"."modeles_messages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."modeles_messages" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "public"."modeles_messages" FROM PUBLIC;--> statement-breakpoint
CREATE POLICY lecture_catalogue ON "public"."modeles_messages" FOR SELECT TO console_app USING (true);--> statement-breakpoint
CREATE POLICY lecture_equipe ON "public"."modeles_messages" FOR SELECT TO console_equipe USING (true);--> statement-breakpoint
CREATE POLICY ajout_equipe ON "public"."modeles_messages" FOR INSERT TO console_equipe WITH CHECK (true);--> statement-breakpoint
CREATE POLICY acteur_obligatoire_insert ON "public"."modeles_messages" AS RESTRICTIVE FOR INSERT TO console_equipe WITH CHECK (NULLIF(current_setting('app.acteur', true), '') IS NOT NULL AND cree_par = NULLIF(current_setting('app.acteur', true), ''));--> statement-breakpoint
GRANT SELECT ON TABLE "public"."modeles_messages" TO console_app;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "public"."modeles_messages" TO console_equipe;--> statement-breakpoint
CREATE TRIGGER modeles_messages_audit AFTER INSERT OR UPDATE OR DELETE ON "public"."modeles_messages" FOR EACH ROW EXECUTE FUNCTION public.audit_ecrire_equipe();--> statement-breakpoint
-- bilans_incident
ALTER TABLE "public"."bilans_incident" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."bilans_incident" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "public"."bilans_incident" FROM PUBLIC;--> statement-breakpoint
CREATE POLICY lecture_catalogue ON "public"."bilans_incident" FOR SELECT TO console_app USING (true);--> statement-breakpoint
CREATE POLICY lecture_equipe ON "public"."bilans_incident" FOR SELECT TO console_equipe USING (true);--> statement-breakpoint
CREATE POLICY ajout_equipe ON "public"."bilans_incident" FOR INSERT TO console_equipe WITH CHECK (true);--> statement-breakpoint
CREATE POLICY acteur_obligatoire_insert ON "public"."bilans_incident" AS RESTRICTIVE FOR INSERT TO console_equipe WITH CHECK (NULLIF(current_setting('app.acteur', true), '') IS NOT NULL AND redige_par = NULLIF(current_setting('app.acteur', true), ''));--> statement-breakpoint
GRANT SELECT ON TABLE "public"."bilans_incident" TO console_app;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "public"."bilans_incident" TO console_equipe;--> statement-breakpoint
CREATE TRIGGER bilans_incident_audit AFTER INSERT OR UPDATE OR DELETE ON "public"."bilans_incident" FOR EACH ROW EXECUTE FUNCTION public.audit_ecrire_equipe();--> statement-breakpoint
-- fenetres_maintenance
ALTER TABLE "public"."fenetres_maintenance" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."fenetres_maintenance" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "public"."fenetres_maintenance" FROM PUBLIC;--> statement-breakpoint
CREATE POLICY lecture_catalogue ON "public"."fenetres_maintenance" FOR SELECT TO console_app USING (true);--> statement-breakpoint
CREATE POLICY lecture_equipe ON "public"."fenetres_maintenance" FOR SELECT TO console_equipe USING (true);--> statement-breakpoint
CREATE POLICY ajout_equipe ON "public"."fenetres_maintenance" FOR INSERT TO console_equipe WITH CHECK (true);--> statement-breakpoint
CREATE POLICY acteur_obligatoire_insert ON "public"."fenetres_maintenance" AS RESTRICTIVE FOR INSERT TO console_equipe WITH CHECK (NULLIF(current_setting('app.acteur', true), '') IS NOT NULL AND auteur = NULLIF(current_setting('app.acteur', true), ''));--> statement-breakpoint
CREATE POLICY modification_equipe ON "public"."fenetres_maintenance" FOR UPDATE TO console_equipe USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY acteur_obligatoire_update ON "public"."fenetres_maintenance" AS RESTRICTIVE FOR UPDATE TO console_equipe USING (true) WITH CHECK (NULLIF(current_setting('app.acteur', true), '') IS NOT NULL);--> statement-breakpoint
GRANT SELECT ON TABLE "public"."fenetres_maintenance" TO console_app;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "public"."fenetres_maintenance" TO console_equipe;--> statement-breakpoint
GRANT UPDATE ("fin", "annoncee_le") ON TABLE "public"."fenetres_maintenance" TO console_equipe;--> statement-breakpoint
CREATE TRIGGER fenetres_maintenance_audit AFTER INSERT OR UPDATE OR DELETE ON "public"."fenetres_maintenance" FOR EACH ROW EXECUTE FUNCTION public.audit_ecrire_equipe();--> statement-breakpoint
-- avis_depreciation
ALTER TABLE "public"."avis_depreciation" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."avis_depreciation" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "public"."avis_depreciation" FROM PUBLIC;--> statement-breakpoint
CREATE POLICY lecture_catalogue ON "public"."avis_depreciation" FOR SELECT TO console_app USING (true);--> statement-breakpoint
CREATE POLICY lecture_equipe ON "public"."avis_depreciation" FOR SELECT TO console_equipe USING (true);--> statement-breakpoint
CREATE POLICY ajout_equipe ON "public"."avis_depreciation" FOR INSERT TO console_equipe WITH CHECK (true);--> statement-breakpoint
CREATE POLICY acteur_obligatoire_insert ON "public"."avis_depreciation" AS RESTRICTIVE FOR INSERT TO console_equipe WITH CHECK (NULLIF(current_setting('app.acteur', true), '') IS NOT NULL);--> statement-breakpoint
CREATE POLICY modification_equipe ON "public"."avis_depreciation" FOR UPDATE TO console_equipe USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY acteur_obligatoire_update ON "public"."avis_depreciation" AS RESTRICTIVE FOR UPDATE TO console_equipe USING (true) WITH CHECK (NULLIF(current_setting('app.acteur', true), '') IS NOT NULL);--> statement-breakpoint
GRANT SELECT ON TABLE "public"."avis_depreciation" TO console_app;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "public"."avis_depreciation" TO console_equipe;--> statement-breakpoint
GRANT UPDATE ("etat") ON TABLE "public"."avis_depreciation" TO console_equipe;--> statement-breakpoint
CREATE TRIGGER avis_depreciation_audit AFTER INSERT OR UPDATE OR DELETE ON "public"."avis_depreciation" FOR EACH ROW EXECUTE FUNCTION public.audit_ecrire_equipe();--> statement-breakpoint
-- Retour arrière (à la main, jamais par une migration) : REVOKE des droits ajoutés (console_lecture, console_app, console_equipe sur les onze tables, UPDATE d'alertes). Tables, colonnes, types, index et contraintes RESTENT (aucune destruction de données).
