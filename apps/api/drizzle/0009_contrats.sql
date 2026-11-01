CREATE TYPE "public"."nature_facture" AS ENUM('abonnement', 'mise_en_place', 'complement_prorata', 'avoir');--> statement-breakpoint
CREATE TYPE "public"."statut_devis" AS ENUM('brouillon', 'envoye', 'accepte', 'refuse', 'expire', 'annule');--> statement-breakpoint
CREATE TYPE "public"."statut_facture" AS ENUM('emise', 'payee', 'impayee', 'annulee');--> statement-breakpoint
CREATE TYPE "public"."type_contrat" AS ENUM('contrat_service', 'sous_traitance_art28', 'bon_de_commande', 'autre');--> statement-breakpoint
CREATE TABLE "apporteurs_clients" (
	"tenant_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"organisation_id" uuid NOT NULL,
	"apporteur_axion_ia_id" text NOT NULL,
	"taux_points_de_base" integer NOT NULL,
	"commissions_dues_centimes" bigint DEFAULT 0 NOT NULL,
	"lu_le" timestamp with time zone NOT NULL,
	CONSTRAINT "apporteurs_clients_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "apporteurs_clients_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "apporteurs_clients_tenant_id_organisation_id_apporteur_unique" UNIQUE("tenant_id","organisation_id","apporteur_axion_ia_id"),
	CONSTRAINT "apporteurs_clients_taux_borne" CHECK ("apporteurs_clients"."taux_points_de_base" BETWEEN 0 AND 10000),
	CONSTRAINT "apporteurs_clients_commissions_positives" CHECK ("apporteurs_clients"."commissions_dues_centimes" >= 0)
);
--> statement-breakpoint
CREATE TABLE "contrats" (
	"tenant_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"organisation_id" uuid NOT NULL,
	"type" "type_contrat" NOT NULL,
	"date_signature" date NOT NULL,
	"pdf_ref" text NOT NULL,
	"empreinte_sha256" text NOT NULL,
	"cree_le" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contrats_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "contrats_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "contrats_pdf_ref_format" CHECK ("contrats"."pdf_ref" ~ '^[A-Za-z0-9][A-Za-z0-9_./-]{0,254}$'),
	CONSTRAINT "contrats_empreinte_format" CHECK ("contrats"."empreinte_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "devis" (
	"tenant_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"organisation_id" uuid NOT NULL,
	"numero_hub" text NOT NULL,
	"proposition_ref" text,
	"pdf_ref" text NOT NULL,
	"date_envoi" timestamp with time zone,
	"duree_validite_jours" integer NOT NULL,
	"statut" "statut_devis" DEFAULT 'brouillon' NOT NULL,
	"motif_annulation" text,
	"annule_le" timestamp with time zone,
	"annule_par" text,
	"cree_le" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "devis_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "devis_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "devis_tenant_id_numero_hub_unique" UNIQUE("tenant_id","numero_hub"),
	CONSTRAINT "devis_pdf_ref_format" CHECK ("devis"."pdf_ref" ~ '^[A-Za-z0-9][A-Za-z0-9_./-]{0,254}$'),
	CONSTRAINT "devis_validite_positive" CHECK ("devis"."duree_validite_jours" > 0),
	CONSTRAINT "devis_annulation_complete" CHECK (("devis"."statut" = 'annule' AND coalesce(length(btrim("devis"."motif_annulation")), 0) > 0 AND "devis"."annule_le" IS NOT NULL AND coalesce(length(btrim("devis"."annule_par")), 0) > 0) OR ("devis"."statut" <> 'annule' AND "devis"."motif_annulation" IS NULL AND "devis"."annule_le" IS NULL AND "devis"."annule_par" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "factures" (
	"tenant_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"organisation_id" uuid NOT NULL,
	"numero" text NOT NULL,
	"hub_id" text NOT NULL,
	"nature" "nature_facture" NOT NULL,
	"plan" text,
	"code_automatisation" text,
	"instance_id" uuid,
	"periode_debut" date NOT NULL,
	"periode_fin" date NOT NULL,
	"montant_ht_centimes" bigint NOT NULL,
	"statut" "statut_facture" DEFAULT 'emise' NOT NULL,
	"pdf_ref" text NOT NULL,
	"empreinte_sha256" text NOT NULL,
	"cree_le" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "factures_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "factures_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "factures_tenant_id_numero_unique" UNIQUE("tenant_id","numero"),
	CONSTRAINT "factures_tenant_id_hub_id_unique" UNIQUE("tenant_id","hub_id"),
	CONSTRAINT "factures_pdf_ref_format" CHECK ("factures"."pdf_ref" ~ '^[A-Za-z0-9][A-Za-z0-9_./-]{0,254}$'),
	CONSTRAINT "factures_empreinte_format" CHECK ("factures"."empreinte_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "factures_montant_positif" CHECK ("factures"."montant_ht_centimes" >= 0),
	CONSTRAINT "factures_periode_ordonnee" CHECK ("factures"."periode_fin" >= "factures"."periode_debut"),
	CONSTRAINT "factures_cle_unicite_presente" CHECK (("factures"."nature" <> 'abonnement' OR "factures"."plan" IS NOT NULL) AND ("factures"."nature" <> 'mise_en_place' OR "factures"."code_automatisation" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "apporteurs_clients" ADD CONSTRAINT "apporteurs_clients_organisation_fk" FOREIGN KEY ("tenant_id","organisation_id") REFERENCES "public"."organisations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contrats" ADD CONSTRAINT "contrats_organisation_fk" FOREIGN KEY ("tenant_id","organisation_id") REFERENCES "public"."organisations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devis" ADD CONSTRAINT "devis_organisation_fk" FOREIGN KEY ("tenant_id","organisation_id") REFERENCES "public"."organisations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "factures" ADD CONSTRAINT "factures_organisation_fk" FOREIGN KEY ("tenant_id","organisation_id") REFERENCES "public"."organisations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "factures" ADD CONSTRAINT "factures_instance_fk" FOREIGN KEY ("tenant_id","instance_id") REFERENCES "public"."instances"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "apporteurs_clients_tenant_id_idx" ON "apporteurs_clients" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "contrats_tenant_id_idx" ON "contrats" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "devis_tenant_id_idx" ON "devis" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "factures_tenant_id_idx" ON "factures" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "factures_abonnement_periode_unique" ON "factures" USING btree ("tenant_id","plan","periode_debut") WHERE "factures"."nature" = 'abonnement';--> statement-breakpoint
CREATE UNIQUE INDEX "factures_mise_en_place_unique" ON "factures" USING btree ("tenant_id","code_automatisation") WHERE "factures"."nature" = 'mise_en_place';--> statement-breakpoint
-- Isolation, droits et audit (modèle de ops/socle/postgres/modele-politique-rls.sql). Aucun DELETE, aucun TRUNCATE. ADR 0053.
-- Contrat signé : ajout seul. Devis et facture : copie des faits du Hub, seuls le statut (et l'annulation du devis) changent. Apporteurs : lecture seule, l'écriture vient de la synchronisation (T2-15).
ALTER TABLE "public"."contrats" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."contrats" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY isolation_client ON "public"."contrats" FOR ALL TO console_app USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY lecture_equipe ON "public"."contrats" FOR SELECT TO console_equipe USING (tenant_id IS NOT NULL);--> statement-breakpoint
REVOKE ALL ON TABLE "public"."contrats" FROM PUBLIC;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "public"."contrats" TO console_app;--> statement-breakpoint
GRANT SELECT ON TABLE "public"."contrats" TO console_equipe;--> statement-breakpoint
CREATE TRIGGER contrats_audit AFTER INSERT OR UPDATE OR DELETE ON "public"."contrats" FOR EACH ROW EXECUTE FUNCTION public.audit_ecrire();--> statement-breakpoint
ALTER TABLE "public"."devis" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."devis" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY isolation_client ON "public"."devis" FOR ALL TO console_app USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY lecture_equipe ON "public"."devis" FOR SELECT TO console_equipe USING (tenant_id IS NOT NULL);--> statement-breakpoint
REVOKE ALL ON TABLE "public"."devis" FROM PUBLIC;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "public"."devis" TO console_app;--> statement-breakpoint
GRANT UPDATE ("statut", "motif_annulation", "annule_le", "annule_par") ON TABLE "public"."devis" TO console_app;--> statement-breakpoint
GRANT SELECT ON TABLE "public"."devis" TO console_equipe;--> statement-breakpoint
CREATE TRIGGER devis_audit AFTER INSERT OR UPDATE OR DELETE ON "public"."devis" FOR EACH ROW EXECUTE FUNCTION public.audit_ecrire();--> statement-breakpoint
ALTER TABLE "public"."factures" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."factures" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY isolation_client ON "public"."factures" FOR ALL TO console_app USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY lecture_equipe ON "public"."factures" FOR SELECT TO console_equipe USING (tenant_id IS NOT NULL);--> statement-breakpoint
REVOKE ALL ON TABLE "public"."factures" FROM PUBLIC;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "public"."factures" TO console_app;--> statement-breakpoint
GRANT UPDATE ("statut") ON TABLE "public"."factures" TO console_app;--> statement-breakpoint
GRANT SELECT ON TABLE "public"."factures" TO console_equipe;--> statement-breakpoint
CREATE TRIGGER factures_audit AFTER INSERT OR UPDATE OR DELETE ON "public"."factures" FOR EACH ROW EXECUTE FUNCTION public.audit_ecrire();--> statement-breakpoint
ALTER TABLE "public"."apporteurs_clients" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."apporteurs_clients" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY isolation_client ON "public"."apporteurs_clients" FOR ALL TO console_app USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY lecture_equipe ON "public"."apporteurs_clients" FOR SELECT TO console_equipe USING (tenant_id IS NOT NULL);--> statement-breakpoint
REVOKE ALL ON TABLE "public"."apporteurs_clients" FROM PUBLIC;--> statement-breakpoint
GRANT SELECT ON TABLE "public"."apporteurs_clients" TO console_app;--> statement-breakpoint
GRANT SELECT ON TABLE "public"."apporteurs_clients" TO console_equipe;--> statement-breakpoint
CREATE TRIGGER apporteurs_clients_audit AFTER INSERT OR UPDATE OR DELETE ON "public"."apporteurs_clients" FOR EACH ROW EXECUTE FUNCTION public.audit_ecrire();--> statement-breakpoint
-- Activation : une instance ne passe à « active » (insertion comprise) que si l'organisation a un contrat de sous-traitance signé. Droits de l'appelant (pas SECURITY DEFINER) :
-- la lecture des contrats suit l'isolation par client, le contrat d'un autre client est invisible. Erreur P0001, message regle_metier, motif sous_traitance_absente.
CREATE OR REPLACE FUNCTION public.instances_exiger_sous_traitance() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.etat = 'active' AND (TG_OP = 'INSERT' OR OLD.etat IS DISTINCT FROM 'active') THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.contrats c
      WHERE c.tenant_id = NEW.tenant_id AND c.organisation_id = NEW.organisation_id
        AND c.type = 'sous_traitance_art28' AND c.date_signature <= current_date
    ) THEN
      RAISE EXCEPTION 'regle_metier' USING ERRCODE = 'P0001', DETAIL = 'sous_traitance_absente';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER instances_sous_traitance BEFORE INSERT OR UPDATE OF etat ON "public"."instances" FOR EACH ROW EXECUTE FUNCTION public.instances_exiger_sous_traitance();--> statement-breakpoint
-- Échéance rattachée à sa facture (additif ; la table vient de la migration 0008, T2-04). Clé étrangère composée, facultative.
ALTER TABLE "echeances" ADD COLUMN "facture" uuid;--> statement-breakpoint
ALTER TABLE "echeances" ADD CONSTRAINT "echeances_facture_fk" FOREIGN KEY ("tenant_id","facture") REFERENCES "public"."factures"("tenant_id","id") ON DELETE no action ON UPDATE no action;
