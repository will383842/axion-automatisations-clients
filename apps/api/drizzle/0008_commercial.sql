CREATE TYPE "public"."mode_avance" AS ENUM('aucune', 'acompte', 'periode_entiere');--> statement-breakpoint
CREATE TYPE "public"."nature_ligne_plan" AS ENUM('mise_en_place', 'recurrente', 'maintenance');--> statement-breakpoint
CREATE TYPE "public"."source_valeur" AS ENUM('grille', 'defaut', 'client', 'instance');--> statement-breakpoint
CREATE TYPE "public"."statut_echeance" AS ENUM('prevue', 'emise', 'payee', 'annulee');--> statement-breakpoint
CREATE TYPE "public"."suite_maintenance" AS ENUM('arret', 'reconduction');--> statement-breakpoint
CREATE TABLE "abonnements" (
	"tenant_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"organisation_id" uuid NOT NULL,
	"conditions_id" uuid,
	"debut" date NOT NULL,
	"fin" date,
	"quotas" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"periode_facturation_mois" integer NOT NULL,
	"mode_avance" "mode_avance" DEFAULT 'aucune' NOT NULL,
	"acompte_points_de_base" integer,
	"auteur" text NOT NULL,
	CONSTRAINT "abonnements_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "abonnements_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "abonnements_periode_valide" CHECK ("abonnements"."periode_facturation_mois" IN (1, 6, 12)),
	CONSTRAINT "abonnements_dates" CHECK ("abonnements"."fin" IS NULL OR "abonnements"."fin" >= "abonnements"."debut"),
	CONSTRAINT "abonnements_quotas_objet" CHECK (jsonb_typeof("abonnements"."quotas") = 'object'),
	CONSTRAINT "abonnements_auteur_non_vide" CHECK (length(btrim("abonnements"."auteur")) > 0),
	CONSTRAINT "abonnements_acompte_coherent" CHECK (("abonnements"."mode_avance" = 'acompte') = ("abonnements"."acompte_points_de_base" IS NOT NULL)),
	CONSTRAINT "abonnements_acompte_taux" CHECK ("abonnements"."acompte_points_de_base" BETWEEN 0 AND 10000)
);
--> statement-breakpoint
CREATE TABLE "conditions_commerciales" (
	"tenant_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"organisation_id" uuid NOT NULL,
	"type" "type_condition" NOT NULL,
	"valeur" jsonb NOT NULL,
	"source" "source_condition" DEFAULT 'client' NOT NULL,
	"valide_du" date,
	"valide_au" date,
	"auteur" text NOT NULL,
	CONSTRAINT "conditions_commerciales_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "conditions_commerciales_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "conditions_commerciales_source_client" CHECK ("conditions_commerciales"."source" = 'client'),
	CONSTRAINT "conditions_commerciales_auteur_non_vide" CHECK (length(btrim("conditions_commerciales"."auteur")) > 0),
	CONSTRAINT "conditions_commerciales_valeur_objet" CHECK (jsonb_typeof("conditions_commerciales"."valeur") = 'object'),
	CONSTRAINT "conditions_commerciales_validite" CHECK ("conditions_commerciales"."valide_du" IS NULL OR "conditions_commerciales"."valide_au" IS NULL OR "conditions_commerciales"."valide_au" >= "conditions_commerciales"."valide_du")
);
--> statement-breakpoint
CREATE TABLE "echeances" (
	"tenant_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"debut_periode" date NOT NULL,
	"fin_periode" date NOT NULL,
	"montant_ht_centimes" bigint NOT NULL,
	"date_emission" date,
	"date_paiement" date,
	"statut" "statut_echeance" DEFAULT 'prevue' NOT NULL,
	"facture_id" uuid,
	"auteur" text NOT NULL,
	CONSTRAINT "echeances_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "echeances_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "echeances_tenant_id_plan_id_debut_periode_unique" UNIQUE("tenant_id","plan_id","debut_periode"),
	CONSTRAINT "echeances_auteur_non_vide" CHECK (length(btrim("echeances"."auteur")) > 0),
	CONSTRAINT "echeances_emission_datee" CHECK ("echeances"."statut" NOT IN ('emise', 'payee') OR "echeances"."date_emission" IS NOT NULL),
	CONSTRAINT "echeances_periode_ordonnee" CHECK ("echeances"."fin_periode" > "echeances"."debut_periode"),
	CONSTRAINT "echeances_montant_entier" CHECK ("echeances"."montant_ht_centimes" BETWEEN 0 AND 9007199254740991),
	CONSTRAINT "echeances_paiement_coherent" CHECK (("echeances"."statut" = 'payee') = ("echeances"."date_paiement" IS NOT NULL)),
	CONSTRAINT "echeances_paiement_apres_emission" CHECK ("echeances"."date_paiement" IS NULL OR "echeances"."date_emission" IS NULL OR "echeances"."date_paiement" >= "echeances"."date_emission"),
	CONSTRAINT "echeances_annulee_facture_datee" CHECK ("echeances"."statut" <> 'annulee' OR "echeances"."facture_id" IS NULL OR "echeances"."date_emission" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "phases_plan" (
	"tenant_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"ordre" integer NOT NULL,
	"debut" date NOT NULL,
	"fin" date,
	"nature" "nature_ligne_plan" NOT NULL,
	"montant_ht_centimes" bigint NOT NULL,
	"periode_facturation_mois" integer NOT NULL,
	"id_plan_hub" text,
	"auteur" text NOT NULL,
	CONSTRAINT "phases_plan_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "phases_plan_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "phases_plan_tenant_id_plan_id_ordre_unique" UNIQUE("tenant_id","plan_id","ordre"),
	CONSTRAINT "phases_plan_auteur_non_vide" CHECK (length(btrim("phases_plan"."auteur")) > 0),
	CONSTRAINT "phases_plan_ordre_positif" CHECK ("phases_plan"."ordre" >= 1),
	CONSTRAINT "phases_plan_dates" CHECK ("phases_plan"."fin" IS NULL OR "phases_plan"."fin" >= "phases_plan"."debut"),
	CONSTRAINT "phases_plan_montant_entier" CHECK ("phases_plan"."montant_ht_centimes" BETWEEN 0 AND 9007199254740991),
	CONSTRAINT "phases_plan_periode_valide" CHECK ("phases_plan"."periode_facturation_mois" IN (1, 6, 12))
);
--> statement-breakpoint
CREATE TABLE "plans_commerciaux" (
	"tenant_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"instance_id" uuid NOT NULL,
	"frais_mise_en_place_ht_centimes" bigint NOT NULL,
	"prix_recurrent_mensuel_ht_centimes" bigint NOT NULL,
	"periode_facturation_mois" integer NOT NULL,
	"mode_avance" "mode_avance" NOT NULL,
	"maintenance_incluse_mois" integer NOT NULL,
	"suite_maintenance" "suite_maintenance" NOT NULL,
	"engagement_mois" integer NOT NULL,
	"source_formule" "source_valeur" NOT NULL,
	"source_frais_mise_en_place" "source_valeur" NOT NULL,
	"source_prix_recurrent_mensuel" "source_valeur" NOT NULL,
	"source_periode_facturation" "source_valeur" NOT NULL,
	"source_mode_avance" "source_valeur" NOT NULL,
	"source_maintenance_incluse" "source_valeur" NOT NULL,
	"source_suite_maintenance" "source_valeur" NOT NULL,
	"source_engagement" "source_valeur" NOT NULL,
	"auteur" text NOT NULL,
	CONSTRAINT "plans_commerciaux_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "plans_commerciaux_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "plans_commerciaux_tenant_id_instance_id_unique" UNIQUE("tenant_id","instance_id"),
	CONSTRAINT "plans_commerciaux_tenant_id_instance_id_id_unique" UNIQUE("tenant_id","instance_id","id"),
	CONSTRAINT "plans_commerciaux_auteur_non_vide" CHECK (length(btrim("plans_commerciaux"."auteur")) > 0),
	CONSTRAINT "plans_commerciaux_frais_entier" CHECK ("plans_commerciaux"."frais_mise_en_place_ht_centimes" BETWEEN 0 AND 9007199254740991),
	CONSTRAINT "plans_commerciaux_prix_entier" CHECK ("plans_commerciaux"."prix_recurrent_mensuel_ht_centimes" BETWEEN 0 AND 9007199254740991),
	CONSTRAINT "plans_commerciaux_periode_valide" CHECK ("plans_commerciaux"."periode_facturation_mois" IN (1, 6, 12)),
	CONSTRAINT "plans_commerciaux_mois_positifs" CHECK ("plans_commerciaux"."maintenance_incluse_mois" >= 0 AND "plans_commerciaux"."engagement_mois" >= 0)
);
--> statement-breakpoint
ALTER TABLE "abonnements" ADD CONSTRAINT "abonnements_organisation_fk" FOREIGN KEY ("tenant_id","organisation_id") REFERENCES "public"."organisations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "abonnements" ADD CONSTRAINT "abonnements_conditions_fk" FOREIGN KEY ("tenant_id","conditions_id") REFERENCES "public"."conditions_commerciales"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conditions_commerciales" ADD CONSTRAINT "conditions_commerciales_organisation_fk" FOREIGN KEY ("tenant_id","organisation_id") REFERENCES "public"."organisations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "echeances" ADD CONSTRAINT "echeances_plan_fk" FOREIGN KEY ("tenant_id","plan_id") REFERENCES "public"."plans_commerciaux"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phases_plan" ADD CONSTRAINT "phases_plan_plan_fk" FOREIGN KEY ("tenant_id","plan_id") REFERENCES "public"."plans_commerciaux"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plans_commerciaux" ADD CONSTRAINT "plans_commerciaux_instance_fk" FOREIGN KEY ("tenant_id","instance_id") REFERENCES "public"."instances"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "abonnements_tenant_id_idx" ON "abonnements" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "conditions_commerciales_tenant_id_idx" ON "conditions_commerciales" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "echeances_tenant_id_idx" ON "echeances" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "phases_plan_tenant_id_idx" ON "phases_plan" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "plans_commerciaux_tenant_id_idx" ON "plans_commerciaux" USING btree ("tenant_id");--> statement-breakpoint
-- Partie écrite à la main (drizzle-kit ne génère ni RLS, ni droits, ni déclencheurs, ni la colonne ajoutée à une table d'une autre fiche), dans la même migration que les tables (ADR 0044, 0052).
-- Argent : solution la plus restrictive (ADR 0052). Aucun DELETE ni TRUNCATE, aucun droit pour PUBLIC ni pour le portail. Le montant, la période et le plan d'une échéance ne se modifient jamais :
-- UPDATE limité par colonnes. Un plan est immuable (aucun UPDATE) ; une phase n'accepte que l'UPDATE de fin, id_plan_hub et auteur (jamais le montant, la période ni la nature) : aucun changement de prix possible avant la règle de correction de T2-08, assumé (ADR 0052). Une échéance annulée ne se remplace pas pour la même période (unicité), assumé de même.
ALTER TABLE "public"."instances" ADD COLUMN "plan_commercial" uuid;--> statement-breakpoint
ALTER TABLE "public"."instances" ADD CONSTRAINT "instances_plan_commercial_fk" FOREIGN KEY ("tenant_id","id","plan_commercial") REFERENCES "public"."plans_commerciaux"("tenant_id","instance_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- La migration 0007 limite la lecture de console_app sur instances à une liste de colonnes : le lien vers le plan doit s'y ajouter (colonne seule, jamais toute la table).
GRANT SELECT ("plan_commercial") ON TABLE "public"."instances" TO console_app;--> statement-breakpoint
ALTER TABLE "public"."conditions_commerciales" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."conditions_commerciales" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY isolation_client ON "public"."conditions_commerciales" FOR ALL TO console_app USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY lecture_equipe ON "public"."conditions_commerciales" FOR SELECT TO console_equipe USING (tenant_id IS NOT NULL);--> statement-breakpoint
REVOKE ALL ON TABLE "public"."conditions_commerciales" FROM PUBLIC;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "public"."conditions_commerciales" TO console_app;--> statement-breakpoint
GRANT UPDATE ("valide_au", "auteur") ON TABLE "public"."conditions_commerciales" TO console_app;--> statement-breakpoint
CREATE POLICY auteur_insertion ON "public"."conditions_commerciales" AS RESTRICTIVE FOR INSERT TO console_app WITH CHECK (auteur = NULLIF(current_setting('app.acteur', true), ''));--> statement-breakpoint
CREATE POLICY auteur_modification ON "public"."conditions_commerciales" AS RESTRICTIVE FOR UPDATE TO console_app USING (true) WITH CHECK (auteur = NULLIF(current_setting('app.acteur', true), ''));--> statement-breakpoint
GRANT SELECT ON TABLE "public"."conditions_commerciales" TO console_equipe;--> statement-breakpoint
CREATE TRIGGER conditions_commerciales_audit AFTER INSERT OR UPDATE OR DELETE ON "public"."conditions_commerciales" FOR EACH ROW EXECUTE FUNCTION public.audit_ecrire();--> statement-breakpoint
ALTER TABLE "public"."abonnements" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."abonnements" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY isolation_client ON "public"."abonnements" FOR ALL TO console_app USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY lecture_equipe ON "public"."abonnements" FOR SELECT TO console_equipe USING (tenant_id IS NOT NULL);--> statement-breakpoint
REVOKE ALL ON TABLE "public"."abonnements" FROM PUBLIC;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "public"."abonnements" TO console_app;--> statement-breakpoint
GRANT UPDATE ("fin", "auteur") ON TABLE "public"."abonnements" TO console_app;--> statement-breakpoint
CREATE POLICY auteur_insertion ON "public"."abonnements" AS RESTRICTIVE FOR INSERT TO console_app WITH CHECK (auteur = NULLIF(current_setting('app.acteur', true), ''));--> statement-breakpoint
CREATE POLICY auteur_modification ON "public"."abonnements" AS RESTRICTIVE FOR UPDATE TO console_app USING (true) WITH CHECK (auteur = NULLIF(current_setting('app.acteur', true), ''));--> statement-breakpoint
GRANT SELECT ON TABLE "public"."abonnements" TO console_equipe;--> statement-breakpoint
CREATE TRIGGER abonnements_audit AFTER INSERT OR UPDATE OR DELETE ON "public"."abonnements" FOR EACH ROW EXECUTE FUNCTION public.audit_ecrire();--> statement-breakpoint
ALTER TABLE "public"."plans_commerciaux" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."plans_commerciaux" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY isolation_client ON "public"."plans_commerciaux" FOR ALL TO console_app USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY lecture_equipe ON "public"."plans_commerciaux" FOR SELECT TO console_equipe USING (tenant_id IS NOT NULL);--> statement-breakpoint
REVOKE ALL ON TABLE "public"."plans_commerciaux" FROM PUBLIC;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "public"."plans_commerciaux" TO console_app;--> statement-breakpoint
CREATE POLICY auteur_insertion ON "public"."plans_commerciaux" AS RESTRICTIVE FOR INSERT TO console_app WITH CHECK (auteur = NULLIF(current_setting('app.acteur', true), ''));--> statement-breakpoint
CREATE POLICY auteur_modification ON "public"."plans_commerciaux" AS RESTRICTIVE FOR UPDATE TO console_app USING (true) WITH CHECK (auteur = NULLIF(current_setting('app.acteur', true), ''));--> statement-breakpoint
GRANT SELECT ON TABLE "public"."plans_commerciaux" TO console_equipe;--> statement-breakpoint
CREATE TRIGGER plans_commerciaux_audit AFTER INSERT OR UPDATE OR DELETE ON "public"."plans_commerciaux" FOR EACH ROW EXECUTE FUNCTION public.audit_ecrire();--> statement-breakpoint
ALTER TABLE "public"."phases_plan" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."phases_plan" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY isolation_client ON "public"."phases_plan" FOR ALL TO console_app USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY lecture_equipe ON "public"."phases_plan" FOR SELECT TO console_equipe USING (tenant_id IS NOT NULL);--> statement-breakpoint
REVOKE ALL ON TABLE "public"."phases_plan" FROM PUBLIC;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "public"."phases_plan" TO console_app;--> statement-breakpoint
GRANT UPDATE ("fin", "id_plan_hub", "auteur") ON TABLE "public"."phases_plan" TO console_app;--> statement-breakpoint
CREATE POLICY auteur_insertion ON "public"."phases_plan" AS RESTRICTIVE FOR INSERT TO console_app WITH CHECK (auteur = NULLIF(current_setting('app.acteur', true), ''));--> statement-breakpoint
CREATE POLICY auteur_modification ON "public"."phases_plan" AS RESTRICTIVE FOR UPDATE TO console_app USING (true) WITH CHECK (auteur = NULLIF(current_setting('app.acteur', true), ''));--> statement-breakpoint
GRANT SELECT ON TABLE "public"."phases_plan" TO console_equipe;--> statement-breakpoint
CREATE TRIGGER phases_plan_audit AFTER INSERT OR UPDATE OR DELETE ON "public"."phases_plan" FOR EACH ROW EXECUTE FUNCTION public.audit_ecrire();--> statement-breakpoint
ALTER TABLE "public"."echeances" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."echeances" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY isolation_client ON "public"."echeances" FOR ALL TO console_app USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY lecture_equipe ON "public"."echeances" FOR SELECT TO console_equipe USING (tenant_id IS NOT NULL);--> statement-breakpoint
REVOKE ALL ON TABLE "public"."echeances" FROM PUBLIC;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "public"."echeances" TO console_app;--> statement-breakpoint
GRANT UPDATE ("statut", "date_emission", "date_paiement", "facture_id", "auteur") ON TABLE "public"."echeances" TO console_app;--> statement-breakpoint
-- Transitions d'une échéance sans fonction ni déclencheur (la garde des migrations les refuse, ADR 0041) : une politique RESTRICTIVE. L'ancienne ligne doit être prevue ou emise
-- (payee et annulee ne se modifient plus : le paiement ne disparaît pas) et la nouvelle emise, payee ou annulee (jamais de retour à prevue). Emise ou payee exige une date d'émission (CHECK).
CREATE POLICY transitions_echeance ON "public"."echeances" AS RESTRICTIVE FOR UPDATE TO console_app USING (tenant_id IS NOT NULL AND statut IN ('prevue', 'emise')) WITH CHECK (tenant_id IS NOT NULL AND statut IN ('emise', 'payee', 'annulee'));--> statement-breakpoint
-- Une échéance émise ne se réécrit pas : l'ancienne ligne est lue par la sous-requête (instantané de début d'instruction), la nouvelle ligne est celle qui est vérifiée. Interdits : emise -> emise, et toute réécriture de date_emission ou de facture_id d'une échéance émise (y compris vers payee ou annulee). Permis : emise -> payee ou annulee sans toucher ces deux colonnes. Les politiques SELECT appliquées à la sous-requête n'ont pas de sous-requête : pas de récursion (ADR 0052, 6 septies).
CREATE POLICY emise_figee ON "public"."echeances" AS RESTRICTIVE FOR UPDATE TO console_app USING (true) WITH CHECK (NOT EXISTS (SELECT 1 FROM public.echeances a WHERE a.tenant_id = echeances.tenant_id AND a.id = echeances.id AND a.statut = 'emise' AND (echeances.statut = 'emise' OR a.date_emission IS DISTINCT FROM echeances.date_emission OR a.facture_id IS DISTINCT FROM echeances.facture_id)));--> statement-breakpoint
CREATE POLICY auteur_insertion ON "public"."echeances" AS RESTRICTIVE FOR INSERT TO console_app WITH CHECK (auteur = NULLIF(current_setting('app.acteur', true), ''));--> statement-breakpoint
CREATE POLICY auteur_modification ON "public"."echeances" AS RESTRICTIVE FOR UPDATE TO console_app USING (true) WITH CHECK (auteur = NULLIF(current_setting('app.acteur', true), ''));--> statement-breakpoint
-- Une échéance se crée toujours prevue, sans date d'émission, sans facture et sans date de paiement : la chaîne des transitions ne se contourne pas à l'insertion (ADR 0052).
CREATE POLICY creation_echeance ON "public"."echeances" AS RESTRICTIVE FOR INSERT TO console_app WITH CHECK (statut = 'prevue' AND date_paiement IS NULL AND date_emission IS NULL AND facture_id IS NULL);--> statement-breakpoint
GRANT SELECT ON TABLE "public"."echeances" TO console_equipe;--> statement-breakpoint
CREATE TRIGGER echeances_audit AFTER INSERT OR UPDATE OR DELETE ON "public"."echeances" FOR EACH ROW EXECUTE FUNCTION public.audit_ecrire();
