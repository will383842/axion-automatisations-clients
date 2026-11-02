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
	"siren" text,
	"siren_actif_verifie_le" timestamp with time zone,
	CONSTRAINT "apporteurs_clients_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "apporteurs_clients_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "apporteurs_clients_tenant_id_organisation_id_apporteur_unique" UNIQUE("tenant_id","organisation_id","apporteur_axion_ia_id"),
	CONSTRAINT "apporteurs_clients_taux_borne" CHECK ("apporteurs_clients"."taux_points_de_base" BETWEEN 0 AND 10000),
	CONSTRAINT "apporteurs_clients_commissions_bornees" CHECK ("apporteurs_clients"."commissions_dues_centimes" BETWEEN 0 AND 9007199254740991),
	CONSTRAINT "apporteurs_clients_siren_format" CHECK ("apporteurs_clients"."siren" ~ '^[0-9]{9}$'),
	CONSTRAINT "apporteurs_clients_commission_siren_actif" CHECK ("apporteurs_clients"."commissions_dues_centimes" = 0 OR ("apporteurs_clients"."siren" IS NOT NULL AND "apporteurs_clients"."siren_actif_verifie_le" IS NOT NULL))
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
	"auteur" text NOT NULL,
	"revoque_le" timestamp with time zone,
	"revoque_par" text,
	CONSTRAINT "contrats_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "contrats_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "contrats_auteur_non_vide" CHECK (length(btrim("contrats"."auteur")) > 0),
	CONSTRAINT "contrats_revocation_complete" CHECK (("contrats"."revoque_le" IS NULL) = ("contrats"."revoque_par" IS NULL) AND ("contrats"."revoque_par" IS NULL OR length(btrim("contrats"."revoque_par")) > 0)),
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
	CONSTRAINT "devis_envoye_date" CHECK ("devis"."statut" <> 'envoye' OR "devis"."date_envoi" IS NOT NULL),
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
	"taux_tva_points_de_base" integer NOT NULL,
	"montant_tva_centimes" bigint NOT NULL,
	"montant_ttc_centimes" bigint NOT NULL,
	"statut" "statut_facture" DEFAULT 'emise' NOT NULL,
	"facture_origine_id" uuid,
	"pdf_ref" text NOT NULL,
	"empreinte_sha256" text NOT NULL,
	"cree_le" timestamp with time zone DEFAULT now() NOT NULL,
	"auteur" text NOT NULL,
	CONSTRAINT "factures_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "factures_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "factures_tenant_id_numero_unique" UNIQUE("tenant_id","numero"),
	CONSTRAINT "factures_tenant_id_hub_id_unique" UNIQUE("tenant_id","hub_id"),
	CONSTRAINT "factures_pdf_ref_format" CHECK ("factures"."pdf_ref" ~ '^[A-Za-z0-9][A-Za-z0-9_./-]{0,254}$'),
	CONSTRAINT "factures_empreinte_format" CHECK ("factures"."empreinte_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "factures_auteur_non_vide" CHECK (length(btrim("factures"."auteur")) > 0),
	CONSTRAINT "factures_montants_bornes" CHECK ("factures"."montant_ht_centimes" BETWEEN 0 AND 9007199254740991 AND "factures"."montant_tva_centimes" BETWEEN 0 AND 9007199254740991 AND "factures"."montant_ttc_centimes" BETWEEN 0 AND 9007199254740991),
	CONSTRAINT "factures_taux_tva_positif" CHECK ("factures"."taux_tva_points_de_base" > 0),
	CONSTRAINT "factures_ttc_coherent" CHECK ("factures"."montant_ttc_centimes" = "factures"."montant_ht_centimes" + "factures"."montant_tva_centimes"),
	CONSTRAINT "factures_tva_arrondie" CHECK ("factures"."montant_tva_centimes" = ("factures"."montant_ht_centimes" * "factures"."taux_tva_points_de_base" + 5000) / 10000),
	CONSTRAINT "factures_avoir_origine" CHECK (("factures"."nature" = 'avoir') = ("factures"."facture_origine_id" IS NOT NULL)),
	CONSTRAINT "factures_plan_non_vide" CHECK (length(btrim("factures"."plan")) > 0),
	CONSTRAINT "factures_code_non_vide" CHECK (length(btrim("factures"."code_automatisation")) > 0),
	CONSTRAINT "factures_periode_ordonnee" CHECK ("factures"."periode_fin" >= "factures"."periode_debut"),
	CONSTRAINT "factures_cle_unicite_presente" CHECK (("factures"."nature" <> 'abonnement' OR "factures"."plan" IS NOT NULL) AND ("factures"."nature" <> 'mise_en_place' OR "factures"."code_automatisation" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "apporteurs_clients" ADD CONSTRAINT "apporteurs_clients_organisation_fk" FOREIGN KEY ("tenant_id","organisation_id") REFERENCES "public"."organisations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contrats" ADD CONSTRAINT "contrats_organisation_fk" FOREIGN KEY ("tenant_id","organisation_id") REFERENCES "public"."organisations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devis" ADD CONSTRAINT "devis_organisation_fk" FOREIGN KEY ("tenant_id","organisation_id") REFERENCES "public"."organisations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "factures" ADD CONSTRAINT "factures_organisation_fk" FOREIGN KEY ("tenant_id","organisation_id") REFERENCES "public"."organisations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "factures" ADD CONSTRAINT "factures_origine_fk" FOREIGN KEY ("tenant_id","facture_origine_id") REFERENCES "public"."factures"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "factures" ADD CONSTRAINT "factures_instance_fk" FOREIGN KEY ("tenant_id","instance_id") REFERENCES "public"."instances"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "apporteurs_clients_tenant_id_idx" ON "apporteurs_clients" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "contrats_tenant_id_idx" ON "contrats" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "devis_tenant_id_idx" ON "devis" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "factures_tenant_id_idx" ON "factures" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "factures_abonnement_periode_unique" ON "factures" USING btree ("tenant_id","plan","periode_debut") WHERE "factures"."nature" = 'abonnement' AND "factures"."statut" <> 'annulee';--> statement-breakpoint
CREATE UNIQUE INDEX "factures_mise_en_place_unique" ON "factures" USING btree ("tenant_id","code_automatisation") WHERE "factures"."nature" = 'mise_en_place' AND "factures"."statut" <> 'annulee';--> statement-breakpoint
ALTER TABLE "echeances" ADD CONSTRAINT "echeances_facture_fk" FOREIGN KEY ("tenant_id","facture_id") REFERENCES "public"."factures"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "echeances_facture_unique" ON "echeances" USING btree ("tenant_id","facture_id") WHERE "echeances"."facture_id" IS NOT NULL;--> statement-breakpoint
-- Isolation, droits et audit (modèle de ops/socle/postgres/modele-politique-rls.sql). Aucun DELETE, aucun TRUNCATE. ADR 0053.
-- Contrat signé : ajout seul, sauf sa révocation (une fois, irréversible). Devis et facture : console_app écrit les COPIES des faits du Hub, sous un appelant nommé (auteur) ; seuls le statut (et l'annulation du devis) changent.
-- Apporteurs : lecture seule, l'écriture vient de la synchronisation (T2-15). Les transitions sont des politiques RESTRICTIVE dont le contrôle de l'ancienne ligne est dans WITH CHECK (sous-requête sur l'état avant écriture) : un refus lève 42501, jamais « 0 ligne » en silence.
ALTER TABLE "public"."contrats" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."contrats" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY isolation_client ON "public"."contrats" FOR ALL TO console_app USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY lecture_equipe ON "public"."contrats" FOR SELECT TO console_equipe USING (tenant_id IS NOT NULL);--> statement-breakpoint
REVOKE ALL ON TABLE "public"."contrats" FROM PUBLIC;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "public"."contrats" TO console_app;--> statement-breakpoint
GRANT UPDATE ("revoque_le", "revoque_par") ON TABLE "public"."contrats" TO console_app;--> statement-breakpoint
CREATE POLICY auteur_insertion ON "public"."contrats" AS RESTRICTIVE FOR INSERT TO console_app WITH CHECK (auteur = NULLIF(current_setting('app.acteur', true), '') AND revoque_le IS NULL AND revoque_par IS NULL);--> statement-breakpoint
CREATE POLICY auteur_modification ON "public"."contrats" AS RESTRICTIVE FOR UPDATE TO console_app USING (true) WITH CHECK (revoque_le IS NOT NULL AND revoque_par = NULLIF(current_setting('app.acteur', true), ''));--> statement-breakpoint
CREATE POLICY revocation_unique ON "public"."contrats" AS RESTRICTIVE FOR UPDATE TO console_app USING (true) WITH CHECK (NOT EXISTS (SELECT 1 FROM public.contrats a WHERE a.tenant_id = contrats.tenant_id AND a.id = contrats.id AND a.revoque_le IS NOT NULL));--> statement-breakpoint
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
CREATE POLICY creation_devis ON "public"."devis" AS RESTRICTIVE FOR INSERT TO console_app WITH CHECK (statut = 'brouillon');--> statement-breakpoint
CREATE POLICY annulation_par_appelant ON "public"."devis" AS RESTRICTIVE FOR UPDATE TO console_app USING (true) WITH CHECK (statut <> 'annule' OR annule_par = NULLIF(current_setting('app.acteur', true), ''));--> statement-breakpoint
CREATE POLICY annule_definitif ON "public"."devis" AS RESTRICTIVE FOR UPDATE TO console_app USING (true) WITH CHECK (NOT EXISTS (SELECT 1 FROM public.devis a WHERE a.tenant_id = devis.tenant_id AND a.id = devis.id AND a.statut = 'annule'));--> statement-breakpoint
CREATE TRIGGER devis_audit AFTER INSERT OR UPDATE OR DELETE ON "public"."devis" FOR EACH ROW EXECUTE FUNCTION public.audit_ecrire();--> statement-breakpoint
ALTER TABLE "public"."factures" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."factures" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY isolation_client ON "public"."factures" FOR ALL TO console_app USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY lecture_equipe ON "public"."factures" FOR SELECT TO console_equipe USING (tenant_id IS NOT NULL);--> statement-breakpoint
REVOKE ALL ON TABLE "public"."factures" FROM PUBLIC;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "public"."factures" TO console_app;--> statement-breakpoint
GRANT UPDATE ("statut", "auteur") ON TABLE "public"."factures" TO console_app;--> statement-breakpoint
CREATE POLICY auteur_insertion ON "public"."factures" AS RESTRICTIVE FOR INSERT TO console_app WITH CHECK (auteur = NULLIF(current_setting('app.acteur', true), ''));--> statement-breakpoint
CREATE POLICY auteur_modification ON "public"."factures" AS RESTRICTIVE FOR UPDATE TO console_app USING (true) WITH CHECK (auteur = NULLIF(current_setting('app.acteur', true), ''));--> statement-breakpoint
CREATE POLICY creation_facture ON "public"."factures" AS RESTRICTIVE FOR INSERT TO console_app WITH CHECK (statut = 'emise');--> statement-breakpoint
CREATE POLICY transitions_facture ON "public"."factures" AS RESTRICTIVE FOR UPDATE TO console_app USING (true) WITH CHECK (statut IN ('payee', 'impayee', 'annulee') AND EXISTS (SELECT 1 FROM public.factures a WHERE a.tenant_id = factures.tenant_id AND a.id = factures.id AND a.statut IN ('emise', 'impayee')));--> statement-breakpoint
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
-- Activation : une instance ne passe à « active » (insertion comprise) que si l'organisation a un contrat de sous-traitance signé et non révoqué. Droits de l'appelant (pas SECURITY DEFINER) :
-- la lecture des contrats suit l'isolation par client, le contrat d'un autre client est invisible. Erreur P0001, message regle_metier, motif sous_traitance_absente.
-- Chemin de recherche fixé et vide de public (tout est qualifié) ; aucun droit d'exécution pour PUBLIC.
CREATE FUNCTION public.instances_exiger_sous_traitance() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.etat = 'active' AND (TG_OP = 'INSERT' OR OLD.etat IS DISTINCT FROM 'active') THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.contrats c
      WHERE c.tenant_id = NEW.tenant_id AND c.organisation_id = NEW.organisation_id
        AND c.type = 'sous_traitance_art28' AND c.date_signature <= current_date AND c.revoque_le IS NULL
    ) THEN
      RAISE EXCEPTION 'regle_metier' USING ERRCODE = 'P0001', DETAIL = 'sous_traitance_absente';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.instances_exiger_sous_traitance() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER instances_sous_traitance BEFORE INSERT OR UPDATE OF etat ON "public"."instances" FOR EACH ROW EXECUTE FUNCTION public.instances_exiger_sous_traitance();--> statement-breakpoint
-- Facture d'une échéance : la clé étrangère composée et l'unicité partielle (une échéance par facture) sont ci-dessus (déclarées dans schema/commercial.ts).
-- Le déclencheur vérifie ce qu'une clé ne dit pas : même organisation que la facture, période de l'échéance (fin exclue) incluse dans celle de la facture (fin incluse).
-- Facture introuvable (ou d'un autre client, invisible) : la clé étrangère la refuse. Droits de l'appelant, chemin de recherche fixé.
CREATE FUNCTION public.echeances_verifier_facture() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v record;
BEGIN
  SELECT f.organisation_id, f.periode_debut, f.periode_fin INTO v
  FROM public.factures f WHERE f.tenant_id = NEW.tenant_id AND f.id = NEW.facture_id;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  IF v.organisation_id IS DISTINCT FROM (
       SELECT i.organisation_id FROM public.plans_commerciaux p
       JOIN public.instances i ON i.tenant_id = p.tenant_id AND i.id = p.instance_id
       WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.plan_id)
     OR NEW.debut_periode < v.periode_debut OR NEW.fin_periode - 1 > v.periode_fin THEN
    RAISE EXCEPTION 'regle_metier' USING ERRCODE = 'P0001', DETAIL = 'facture_incoherente';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.echeances_verifier_facture() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER echeances_facture BEFORE INSERT OR UPDATE OF facture_id, debut_periode, fin_periode, plan_id ON "public"."echeances" FOR EACH ROW WHEN (NEW.facture_id IS NOT NULL) EXECUTE FUNCTION public.echeances_verifier_facture();
