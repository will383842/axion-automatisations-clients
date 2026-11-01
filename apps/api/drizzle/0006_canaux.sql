CREATE TYPE "public"."destination_envoi" AS ENUM('hub', 'crm');--> statement-breakpoint
CREATE TYPE "public"."etat_a_trancher" AS ENUM('ouvert', 'tranche');--> statement-breakpoint
CREATE TYPE "public"."etat_alerte" AS ENUM('ouverte', 'acquittee', 'close');--> statement-breakpoint
CREATE TYPE "public"."etat_envoi" AS ENUM('a_envoyer', 'en_cours', 'envoye', 'echec');--> statement-breakpoint
CREATE TYPE "public"."etat_lien_crm" AS ENUM('actif', 'absorbe');--> statement-breakpoint
CREATE TYPE "public"."gravite_alerte" AS ENUM('information', 'avertissement', 'critique');--> statement-breakpoint
CREATE TYPE "public"."methode_envoi" AS ENUM('POST', 'PUT', 'PATCH', 'DELETE');--> statement-breakpoint
CREATE TYPE "public"."motif_a_trancher" AS ENUM('siren_absent_ressemblance', 'ressaisie_manuelle', 'email_change', 'fiche_absorbee', 'incoherence_nuit');--> statement-breakpoint
CREATE TYPE "public"."motif_exclusion" AS ENUM('rebond', 'plainte', 'desabonnement', 'demande_client');--> statement-breakpoint
CREATE TYPE "public"."portee_exclusion" AS ENUM('client', 'plateforme');--> statement-breakpoint
CREATE TYPE "public"."resultat_fait" AS ENUM('traite', 'ignore', 'a_trancher', 'erreur');--> statement-breakpoint
CREATE TYPE "public"."source_canal" AS ENUM('hub', 'crm');--> statement-breakpoint
CREATE TYPE "public"."source_condition" AS ENUM('defaut', 'client');--> statement-breakpoint
CREATE TYPE "public"."source_exclusion" AS ENUM('retour_rebond', 'rapport_plainte', 'lien_desinscription', 'saisie_equipe');--> statement-breakpoint
CREATE TYPE "public"."type_condition" AS ENUM('remise', 'frais', 'engagement', 'garantie', 'delai', 'seuil_alerte', 'periode');--> statement-breakpoint
CREATE TABLE "a_trancher" (
	"tenant_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"organisation_id" uuid,
	"source" "source_canal" NOT NULL,
	"motif" "motif_a_trancher" NOT NULL,
	"donnees_comparaison" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"etat" "etat_a_trancher" DEFAULT 'ouvert' NOT NULL,
	"tranche_par" text,
	"decision" text,
	"cree_le" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "a_trancher_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "a_trancher_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "a_trancher_cloture" CHECK (("a_trancher"."etat" = 'ouvert' AND "a_trancher"."decision" IS NULL AND "a_trancher"."tranche_par" IS NULL) OR ("a_trancher"."etat" = 'tranche' AND coalesce(length(btrim("a_trancher"."decision")), 0) > 0 AND coalesce(length(btrim("a_trancher"."tranche_par")), 0) > 0))
);
--> statement-breakpoint
CREATE TABLE "alertes_plateforme" (
	"tenant_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"type" text NOT NULL,
	"gravite" "gravite_alerte" NOT NULL,
	"regle" text NOT NULL,
	"etat" "etat_alerte" DEFAULT 'ouverte' NOT NULL,
	"assignee_a" text,
	"cree_le" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "alertes_plateforme_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "alertes_plateforme_tenant_id_id_unique" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "boite_envoi" (
	"tenant_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"destination" "destination_envoi" NOT NULL,
	"route" text NOT NULL,
	"methode" "methode_envoi" NOT NULL,
	"corps" jsonb NOT NULL,
	"cle_anti_doublon" uuid NOT NULL,
	"empreinte_corps" text NOT NULL,
	"etat" "etat_envoi" DEFAULT 'a_envoyer' NOT NULL,
	"nombre_essais" integer DEFAULT 0 NOT NULL,
	"prochain_essai" timestamp with time zone,
	"derniere_erreur" text,
	"reponse_recue" jsonb,
	"cree_le" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "boite_envoi_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "boite_envoi_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "boite_envoi_tenant_id_cle_anti_doublon_unique" UNIQUE("tenant_id","cle_anti_doublon"),
	CONSTRAINT "boite_envoi_empreinte_format" CHECK ("boite_envoi"."empreinte_corps" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "boite_envoi_essais_positifs" CHECK ("boite_envoi"."nombre_essais" >= 0),
	CONSTRAINT "boite_envoi_derniere_erreur_code" CHECK ("boite_envoi"."derniere_erreur" ~ '^[a-z0-9_.-]{1,64}$')
);
--> statement-breakpoint
CREATE TABLE "conditions_par_defaut" (
	"tenant_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"type" "type_condition" NOT NULL,
	"valeur" jsonb NOT NULL,
	"source" "source_condition" DEFAULT 'defaut' NOT NULL,
	"valide_du" date,
	"valide_au" date,
	CONSTRAINT "conditions_par_defaut_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "conditions_par_defaut_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "conditions_par_defaut_source_defaut" CHECK ("conditions_par_defaut"."source" = 'defaut'),
	CONSTRAINT "conditions_par_defaut_validite" CHECK ("conditions_par_defaut"."valide_du" IS NULL OR "conditions_par_defaut"."valide_au" IS NULL OR "conditions_par_defaut"."valide_au" >= "conditions_par_defaut"."valide_du")
);
--> statement-breakpoint
CREATE TABLE "exclusions" (
	"tenant_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"portee" "portee_exclusion" DEFAULT 'client' NOT NULL,
	"empreinte_email" text NOT NULL,
	"motif" "motif_exclusion" NOT NULL,
	"source" "source_exclusion" NOT NULL,
	"cree_le" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "exclusions_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "exclusions_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "exclusions_tenant_id_empreinte_email_unique" UNIQUE("tenant_id","empreinte_email"),
	CONSTRAINT "exclusions_empreinte_format" CHECK ("exclusions"."empreinte_email" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "exclusions_portee_client" CHECK ("exclusions"."portee" = 'client')
);
--> statement-breakpoint
CREATE TABLE "exclusions_plateforme" (
	"empreinte_email" text PRIMARY KEY NOT NULL,
	"motif" "motif_exclusion" NOT NULL,
	"source" "source_exclusion" NOT NULL,
	"ajoute_par" text NOT NULL,
	"cree_le" date DEFAULT now() NOT NULL,
	CONSTRAINT "exclusions_plateforme_auteur_non_vide" CHECK (length(btrim("exclusions_plateforme"."ajoute_par")) > 0),
	CONSTRAINT "exclusions_plateforme_empreinte_format" CHECK ("exclusions_plateforme"."empreinte_email" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "exclusions_plateforme_motif_commun" CHECK ("exclusions_plateforme"."motif" IN ('rebond', 'plainte'))
);
--> statement-breakpoint
CREATE TABLE "faits_recus" (
	"tenant_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"source" "source_canal" NOT NULL,
	"event_id" uuid NOT NULL,
	"type" text NOT NULL,
	"sequence" bigint NOT NULL,
	"sujet" text NOT NULL,
	"recu_le" timestamp with time zone DEFAULT now() NOT NULL,
	"traite_le" timestamp with time zone,
	"resultat" "resultat_fait",
	CONSTRAINT "faits_recus_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "faits_recus_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "faits_recus_tenant_id_source_event_id_unique" UNIQUE("tenant_id","source","event_id"),
	CONSTRAINT "faits_recus_traitement_complet" CHECK (("faits_recus"."traite_le" IS NULL) = ("faits_recus"."resultat" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "liens_crm" (
	"tenant_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"organisation_id" uuid NOT NULL,
	"crm_company_id" text NOT NULL,
	"etat" "etat_lien_crm" DEFAULT 'actif' NOT NULL,
	"absorbe_par" text,
	CONSTRAINT "liens_crm_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "liens_crm_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "liens_crm_tenant_id_crm_company_id_unique" UNIQUE("tenant_id","crm_company_id"),
	CONSTRAINT "liens_crm_absorbe_complet" CHECK (("liens_crm"."etat" = 'absorbe') = ("liens_crm"."absorbe_par" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "reglage_global_fin_de_contrat" (
	"tenant_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"delai_proposition_suppression_mois" integer NOT NULL,
	"auteur" text NOT NULL,
	"change_le" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reglage_global_fin_de_contrat_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "reglage_global_fin_de_contrat_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "reglage_global_delai_minimal" CHECK ("reglage_global_fin_de_contrat"."delai_proposition_suppression_mois" >= 2)
);
--> statement-breakpoint
ALTER TABLE "a_trancher" ADD CONSTRAINT "a_trancher_organisation_fk" FOREIGN KEY ("tenant_id","organisation_id") REFERENCES "public"."organisations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "liens_crm" ADD CONSTRAINT "liens_crm_organisation_fk" FOREIGN KEY ("tenant_id","organisation_id") REFERENCES "public"."organisations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "a_trancher_tenant_id_idx" ON "a_trancher" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "alertes_plateforme_tenant_id_idx" ON "alertes_plateforme" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "boite_envoi_tenant_id_idx" ON "boite_envoi" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "conditions_par_defaut_tenant_id_idx" ON "conditions_par_defaut" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "exclusions_tenant_id_idx" ON "exclusions" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "faits_recus_tenant_id_idx" ON "faits_recus" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "liens_crm_tenant_id_idx" ON "liens_crm" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "reglage_global_fin_de_contrat_tenant_id_idx" ON "reglage_global_fin_de_contrat" USING btree ("tenant_id");--> statement-breakpoint
-- Partie écrite à la main (drizzle-kit ne génère ni RLS, ni droits, ni déclencheurs), dans la même migration que les tables (ADR 0044, 0050).
-- Droits : aucun DELETE ni TRUNCATE, aucun droit pour PUBLIC ni pour le portail (rôle absent de la base console). La clé anti-doublon, le corps,
-- l'event_id et l'empreinte d'e-mail ne se modifient jamais : UPDATE limité par colonnes. Pas de déclencheur d'audit sur les tables de volume ni de données de personnes.

ALTER TABLE "public"."boite_envoi" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."boite_envoi" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY isolation_client ON "public"."boite_envoi" FOR ALL TO console_app USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY lecture_equipe ON "public"."boite_envoi" FOR SELECT TO console_equipe USING (tenant_id IS NOT NULL);--> statement-breakpoint
REVOKE ALL ON TABLE "public"."boite_envoi" FROM PUBLIC;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "public"."boite_envoi" TO console_app;--> statement-breakpoint
GRANT UPDATE ("etat", "nombre_essais", "prochain_essai", "derniere_erreur", "reponse_recue") ON TABLE "public"."boite_envoi" TO console_app;--> statement-breakpoint
GRANT SELECT ON TABLE "public"."boite_envoi" TO console_equipe;--> statement-breakpoint
ALTER TABLE "public"."faits_recus" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."faits_recus" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY isolation_client ON "public"."faits_recus" FOR ALL TO console_app USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY lecture_equipe ON "public"."faits_recus" FOR SELECT TO console_equipe USING (tenant_id IS NOT NULL);--> statement-breakpoint
REVOKE ALL ON TABLE "public"."faits_recus" FROM PUBLIC;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "public"."faits_recus" TO console_app;--> statement-breakpoint
GRANT UPDATE ("traite_le", "resultat") ON TABLE "public"."faits_recus" TO console_app;--> statement-breakpoint
GRANT SELECT ON TABLE "public"."faits_recus" TO console_equipe;--> statement-breakpoint
ALTER TABLE "public"."liens_crm" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."liens_crm" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY isolation_client ON "public"."liens_crm" FOR ALL TO console_app USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY lecture_equipe ON "public"."liens_crm" FOR SELECT TO console_equipe USING (tenant_id IS NOT NULL);--> statement-breakpoint
REVOKE ALL ON TABLE "public"."liens_crm" FROM PUBLIC;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "public"."liens_crm" TO console_app;--> statement-breakpoint
GRANT UPDATE ("etat", "absorbe_par") ON TABLE "public"."liens_crm" TO console_app;--> statement-breakpoint
GRANT SELECT ON TABLE "public"."liens_crm" TO console_equipe;--> statement-breakpoint
CREATE TRIGGER liens_crm_audit AFTER INSERT OR UPDATE OR DELETE ON "public"."liens_crm" FOR EACH ROW EXECUTE FUNCTION public.audit_ecrire();--> statement-breakpoint
ALTER TABLE "public"."a_trancher" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."a_trancher" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY isolation_client ON "public"."a_trancher" FOR ALL TO console_app USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY lecture_equipe ON "public"."a_trancher" FOR SELECT TO console_equipe USING (tenant_id IS NOT NULL);--> statement-breakpoint
REVOKE ALL ON TABLE "public"."a_trancher" FROM PUBLIC;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "public"."a_trancher" TO console_app;--> statement-breakpoint
GRANT UPDATE ("etat", "tranche_par", "decision") ON TABLE "public"."a_trancher" TO console_app;--> statement-breakpoint
GRANT SELECT ON TABLE "public"."a_trancher" TO console_equipe;--> statement-breakpoint
CREATE TRIGGER a_trancher_audit AFTER INSERT OR UPDATE OR DELETE ON "public"."a_trancher" FOR EACH ROW EXECUTE FUNCTION public.audit_ecrire();--> statement-breakpoint
ALTER TABLE "public"."exclusions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."exclusions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY isolation_client ON "public"."exclusions" FOR ALL TO console_app USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY lecture_equipe ON "public"."exclusions" FOR SELECT TO console_equipe USING (tenant_id IS NOT NULL);--> statement-breakpoint
REVOKE ALL ON TABLE "public"."exclusions" FROM PUBLIC;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "public"."exclusions" TO console_app;--> statement-breakpoint
GRANT SELECT ON TABLE "public"."exclusions" TO console_equipe;--> statement-breakpoint
-- Liste commune (sans tenant_id) : tout client la lit, seule l'équipe y ajoute ; ni modification ni suppression (ajout seul).
ALTER TABLE "public"."exclusions_plateforme" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."exclusions_plateforme" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY lecture_commune ON "public"."exclusions_plateforme" FOR SELECT TO console_app, console_equipe USING (true);--> statement-breakpoint
CREATE POLICY ajout_equipe ON "public"."exclusions_plateforme" FOR INSERT TO console_equipe WITH CHECK (true);--> statement-breakpoint
REVOKE ALL ON TABLE "public"."exclusions_plateforme" FROM PUBLIC;--> statement-breakpoint
GRANT SELECT ON TABLE "public"."exclusions_plateforme" TO console_app;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "public"."exclusions_plateforme" TO console_equipe;--> statement-breakpoint
-- Lignes de la plateforme (ADR 0040) : tenant_id obligatoire, lignes globales sous l'organisation réservée « plateforme ». Lecture par console_app : client actif OU plateforme ;
-- écriture par console_equipe seul ; aucun droit pour le portail. La première ligne du réglage global (24) est posée AVANT FORCE ROW LEVEL SECURITY, comme l'organisation « plateforme » en 0004.
INSERT INTO "public"."reglage_global_fin_de_contrat" ("tenant_id", "id", "delai_proposition_suppression_mois", "auteur") VALUES ('00000000-0000-0000-0000-000000000001', gen_random_uuid(), 24, 'migration');--> statement-breakpoint
ALTER TABLE "public"."reglage_global_fin_de_contrat" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."reglage_global_fin_de_contrat" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY lecture_client_ou_plateforme ON "public"."reglage_global_fin_de_contrat" FOR SELECT TO console_app USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid OR tenant_id = '00000000-0000-0000-0000-000000000001'::uuid);--> statement-breakpoint
CREATE POLICY lecture_equipe ON "public"."reglage_global_fin_de_contrat" FOR SELECT TO console_equipe USING (tenant_id IS NOT NULL);--> statement-breakpoint
CREATE POLICY ajout_equipe ON "public"."reglage_global_fin_de_contrat" FOR INSERT TO console_equipe WITH CHECK (tenant_id IS NOT NULL);--> statement-breakpoint
REVOKE ALL ON TABLE "public"."reglage_global_fin_de_contrat" FROM PUBLIC;--> statement-breakpoint
GRANT SELECT ON TABLE "public"."reglage_global_fin_de_contrat" TO console_app;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "public"."reglage_global_fin_de_contrat" TO console_equipe;--> statement-breakpoint
ALTER TABLE "public"."conditions_par_defaut" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."conditions_par_defaut" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY lecture_client_ou_plateforme ON "public"."conditions_par_defaut" FOR SELECT TO console_app USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid OR tenant_id = '00000000-0000-0000-0000-000000000001'::uuid);--> statement-breakpoint
CREATE POLICY lecture_equipe ON "public"."conditions_par_defaut" FOR SELECT TO console_equipe USING (tenant_id IS NOT NULL);--> statement-breakpoint
CREATE POLICY ajout_equipe ON "public"."conditions_par_defaut" FOR INSERT TO console_equipe WITH CHECK (tenant_id IS NOT NULL);--> statement-breakpoint
REVOKE ALL ON TABLE "public"."conditions_par_defaut" FROM PUBLIC;--> statement-breakpoint
GRANT SELECT ON TABLE "public"."conditions_par_defaut" TO console_app;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "public"."conditions_par_defaut" TO console_equipe;--> statement-breakpoint
ALTER TABLE "public"."alertes_plateforme" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."alertes_plateforme" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY lecture_client_ou_plateforme ON "public"."alertes_plateforme" FOR SELECT TO console_app USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid OR tenant_id = '00000000-0000-0000-0000-000000000001'::uuid);--> statement-breakpoint
CREATE POLICY lecture_equipe ON "public"."alertes_plateforme" FOR SELECT TO console_equipe USING (tenant_id IS NOT NULL);--> statement-breakpoint
CREATE POLICY ajout_equipe ON "public"."alertes_plateforme" FOR INSERT TO console_equipe WITH CHECK (tenant_id IS NOT NULL);--> statement-breakpoint
CREATE POLICY changement_equipe ON "public"."alertes_plateforme" FOR UPDATE TO console_equipe USING (tenant_id IS NOT NULL) WITH CHECK (tenant_id IS NOT NULL);--> statement-breakpoint
REVOKE ALL ON TABLE "public"."alertes_plateforme" FROM PUBLIC;--> statement-breakpoint
GRANT SELECT ON TABLE "public"."alertes_plateforme" TO console_app;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "public"."alertes_plateforme" TO console_equipe;--> statement-breakpoint
GRANT UPDATE ("etat", "assignee_a") ON TABLE "public"."alertes_plateforme" TO console_equipe;
