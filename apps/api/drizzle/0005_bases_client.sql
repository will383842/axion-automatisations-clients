CREATE TYPE "public"."cause_effacement" AS ENUM('litige_en_cours', 'obligation_legale', 'decision_de_will');--> statement-breakpoint
CREATE TYPE "public"."decision_effacement" AS ENUM('accepter', 'refuser', 'ecarter');--> statement-breakpoint
CREATE TYPE "public"."etat_base_client" AS ENUM('en_creation', 'active', 'gelee', 'exportee', 'a_l_ecart', 'effacee');--> statement-breakpoint
CREATE TYPE "public"."etat_demande_effacement" AS ENUM('en_attente', 'acceptee', 'refusee');--> statement-breakpoint
CREATE TYPE "public"."etat_fin_de_contrat" AS ENUM('preavis', 'export_disponible', 'a_l_ecart', 'effacee');--> statement-breakpoint
CREATE TYPE "public"."etat_proposition" AS ENUM('en_attente', 'acceptee', 'ecartee', 'reexamen', 'executee');--> statement-breakpoint
CREATE TYPE "public"."nature_attestation" AS ENUM('mise_a_l_ecart', 'effacement');--> statement-breakpoint
CREATE TYPE "public"."resultat_version" AS ENUM('ok', 'echec', 'quarantaine');--> statement-breakpoint
CREATE TYPE "public"."role_confirmation" AS ENUM('will', 'second_administrateur');--> statement-breakpoint
CREATE TABLE "attestations_fin_de_contrat" (
	"tenant_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"fin_de_contrat_id" uuid NOT NULL,
	"nature" "nature_attestation" NOT NULL,
	"pdf_reference" text NOT NULL,
	"empreinte_sha256" text NOT NULL,
	CONSTRAINT "attestations_fin_de_contrat_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "attestations_fin_de_contrat_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "attestations_empreinte_format" CHECK ("attestations_fin_de_contrat"."empreinte_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "bases_client" (
	"tenant_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"organisation_id" uuid NOT NULL,
	"grappe" text NOT NULL,
	"nom_base" text NOT NULL,
	"version_structure" integer DEFAULT 0 NOT NULL,
	"taille_octets" bigint DEFAULT 0 NOT NULL,
	"quota_base_octets" bigint,
	"quota_fichiers_octets" bigint,
	"quota_personnes" integer,
	"derniere_sauvegarde" timestamp with time zone,
	"dernier_test_restauration" timestamp with time zone,
	"etat" "etat_base_client" DEFAULT 'en_creation' NOT NULL,
	"etape_provisionnement" integer DEFAULT 0 NOT NULL,
	"derniere_erreur" text,
	CONSTRAINT "bases_client_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "bases_client_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "bases_client_tenant_id_nom_base_unique" UNIQUE("tenant_id","nom_base"),
	CONSTRAINT "bases_client_nom_base_derive" CHECK ("bases_client"."nom_base" = 'cli_' || replace("bases_client"."tenant_id"::text, '-', '')),
	CONSTRAINT "bases_client_derniere_erreur_code" CHECK ("bases_client"."derniere_erreur" ~ '^[a-z0-9_.-]{1,64}$'),
	CONSTRAINT "bases_client_mesures_positives" CHECK ("bases_client"."taille_octets" >= 0 AND "bases_client"."etape_provisionnement" >= 0 AND "bases_client"."version_structure" >= 0)
);
--> statement-breakpoint
CREATE TABLE "confirmations_mise_a_l_ecart" (
	"tenant_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"fin_de_contrat_id" uuid NOT NULL,
	"confirmateur" uuid NOT NULL,
	"role" "role_confirmation" NOT NULL,
	"confirmee_le" timestamp with time zone DEFAULT now() NOT NULL,
	"reauth_le" timestamp with time zone NOT NULL,
	CONSTRAINT "confirmations_mise_a_l_ecart_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "confirmations_mise_a_l_ecart_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "confirmations_tenant_id_fin_role_unique" UNIQUE("tenant_id","fin_de_contrat_id","role")
);
--> statement-breakpoint
CREATE TABLE "decisions_effacement" (
	"tenant_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"demande_id" uuid,
	"proposition_id" uuid,
	"decideur" uuid NOT NULL,
	"decision" "decision_effacement" NOT NULL,
	"motif_ecrit" text NOT NULL,
	"cause" "cause_effacement",
	"gel_id" uuid,
	"reference_texte" text,
	"decidee_le" timestamp with time zone DEFAULT now() NOT NULL,
	"reauth_le" timestamp with time zone NOT NULL,
	CONSTRAINT "decisions_effacement_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "decisions_effacement_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "decisions_une_seule_cible" CHECK (num_nonnulls("decisions_effacement"."demande_id", "decisions_effacement"."proposition_id") = 1),
	CONSTRAINT "decisions_motif_non_vide" CHECK (length(btrim("decisions_effacement"."motif_ecrit")) > 0),
	CONSTRAINT "decisions_cause_selon_decision" CHECK (("decisions_effacement"."decision" = 'accepter' AND "decisions_effacement"."cause" IS NULL) OR ("decisions_effacement"."decision" IN ('refuser', 'ecarter') AND "decisions_effacement"."cause" IS NOT NULL)),
	CONSTRAINT "decisions_decision_de_will_ecarter" CHECK ("decisions_effacement"."cause" IS DISTINCT FROM 'decision_de_will' OR "decisions_effacement"."decision" = 'ecarter'),
	CONSTRAINT "decisions_gel_si_litige" CHECK ("decisions_effacement"."cause" IS DISTINCT FROM 'litige_en_cours' OR "decisions_effacement"."gel_id" IS NOT NULL),
	CONSTRAINT "decisions_texte_si_obligation" CHECK ("decisions_effacement"."cause" IS DISTINCT FROM 'obligation_legale' OR coalesce(length(btrim("decisions_effacement"."reference_texte")), 0) > 0)
);
--> statement-breakpoint
CREATE TABLE "demandes_effacement" (
	"tenant_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"fin_de_contrat_id" uuid NOT NULL,
	"recue_le" timestamp with time zone DEFAULT now() NOT NULL,
	"ecrit_reference" text NOT NULL,
	"etat" "etat_demande_effacement" DEFAULT 'en_attente' NOT NULL,
	CONSTRAINT "demandes_effacement_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "demandes_effacement_tenant_id_id_unique" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "fins_de_contrat" (
	"tenant_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"organisation_id" uuid NOT NULL,
	"date_fin" date NOT NULL,
	"preavis_j1_envoye_le" timestamp with time zone,
	"preavis_j1_accuse" text,
	"preavis_j20_envoye_le" timestamp with time zone,
	"preavis_j20_accuse" text,
	"preavis_j27_envoye_le" timestamp with time zone,
	"preavis_j27_accuse" text,
	"export_reference" text,
	"export_expire_le" timestamp with time zone,
	"export_telecharge_le" timestamp with time zone,
	"etat" "etat_fin_de_contrat" DEFAULT 'preavis' NOT NULL,
	CONSTRAINT "fins_de_contrat_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "fins_de_contrat_tenant_id_id_unique" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "gels_litige" (
	"tenant_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"organisation_id" uuid NOT NULL,
	"motif_litige" text NOT NULL,
	"posee_le" timestamp with time zone DEFAULT now() NOT NULL,
	"posee_par" text NOT NULL,
	"levee_le" timestamp with time zone,
	"leve_par" text,
	CONSTRAINT "gels_litige_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "gels_litige_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "gels_litige_motif_non_vide" CHECK (length(btrim("gels_litige"."motif_litige")) > 0),
	CONSTRAINT "gels_litige_levee_complete" CHECK (("gels_litige"."levee_le" IS NULL) = ("gels_litige"."leve_par" IS NULL) AND ("gels_litige"."levee_le" IS NULL OR "gels_litige"."levee_le" >= "gels_litige"."posee_le"))
);
--> statement-breakpoint
CREATE TABLE "propositions_suppression" (
	"tenant_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"fin_de_contrat_id" uuid NOT NULL,
	"echeance" date NOT NULL,
	"etat" "etat_proposition" DEFAULT 'en_attente' NOT NULL,
	"gel_id" uuid,
	"cree_le" timestamp with time zone DEFAULT now() NOT NULL,
	"avis_client_le" timestamp with time zone,
	"avis_client_preuve" text,
	"rappels_envoyes" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "propositions_suppression_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "propositions_suppression_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "propositions_tenant_id_fin_echeance_unique" UNIQUE("tenant_id","fin_de_contrat_id","echeance"),
	CONSTRAINT "propositions_rappels_positifs" CHECK ("propositions_suppression"."rappels_envoyes" >= 0)
);
--> statement-breakpoint
CREATE TABLE "reglages_fin_de_contrat" (
	"tenant_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"organisation_id" uuid NOT NULL,
	"delai_proposition_suppression_mois" integer NOT NULL,
	"auteur" text NOT NULL,
	"change_le" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reglages_fin_de_contrat_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "reglages_fin_de_contrat_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "reglages_delai_minimal" CHECK ("reglages_fin_de_contrat"."delai_proposition_suppression_mois" >= 2)
);
--> statement-breakpoint
CREATE TABLE "versions_structure" (
	"tenant_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"base_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"appliquee_le" timestamp with time zone DEFAULT now() NOT NULL,
	"resultat" "resultat_version" NOT NULL,
	"vague" integer,
	CONSTRAINT "versions_structure_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "versions_structure_tenant_id_id_unique" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "visibilite_acces" (
	"tenant_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"organisation_id" uuid NOT NULL,
	"lien_retour" text,
	"page_reference" text,
	"accords_ecrits_le" date[] DEFAULT '{}' NOT NULL,
	"intervention_perimetre" text,
	"intervention_debut" timestamp with time zone,
	"intervention_fin" timestamp with time zone,
	CONSTRAINT "visibilite_acces_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "visibilite_acces_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "visibilite_tenant_id_organisation_unique" UNIQUE("tenant_id","organisation_id"),
	CONSTRAINT "visibilite_intervention_complete" CHECK (("visibilite_acces"."intervention_perimetre" IS NULL) = ("visibilite_acces"."intervention_debut" IS NULL) AND ("visibilite_acces"."intervention_debut" IS NULL) = ("visibilite_acces"."intervention_fin" IS NULL) AND ("visibilite_acces"."intervention_fin" IS NULL OR "visibilite_acces"."intervention_fin" > "visibilite_acces"."intervention_debut"))
);
--> statement-breakpoint
ALTER TABLE "attestations_fin_de_contrat" ADD CONSTRAINT "attestations_fin_de_contrat_fk" FOREIGN KEY ("tenant_id","fin_de_contrat_id") REFERENCES "public"."fins_de_contrat"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bases_client" ADD CONSTRAINT "bases_client_organisation_fk" FOREIGN KEY ("tenant_id","organisation_id") REFERENCES "public"."organisations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "confirmations_mise_a_l_ecart" ADD CONSTRAINT "confirmations_fin_de_contrat_fk" FOREIGN KEY ("tenant_id","fin_de_contrat_id") REFERENCES "public"."fins_de_contrat"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions_effacement" ADD CONSTRAINT "decisions_demande_fk" FOREIGN KEY ("tenant_id","demande_id") REFERENCES "public"."demandes_effacement"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions_effacement" ADD CONSTRAINT "decisions_proposition_fk" FOREIGN KEY ("tenant_id","proposition_id") REFERENCES "public"."propositions_suppression"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions_effacement" ADD CONSTRAINT "decisions_gel_fk" FOREIGN KEY ("tenant_id","gel_id") REFERENCES "public"."gels_litige"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demandes_effacement" ADD CONSTRAINT "demandes_fin_de_contrat_fk" FOREIGN KEY ("tenant_id","fin_de_contrat_id") REFERENCES "public"."fins_de_contrat"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fins_de_contrat" ADD CONSTRAINT "fins_de_contrat_organisation_fk" FOREIGN KEY ("tenant_id","organisation_id") REFERENCES "public"."organisations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gels_litige" ADD CONSTRAINT "gels_litige_organisation_fk" FOREIGN KEY ("tenant_id","organisation_id") REFERENCES "public"."organisations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "propositions_suppression" ADD CONSTRAINT "propositions_fin_de_contrat_fk" FOREIGN KEY ("tenant_id","fin_de_contrat_id") REFERENCES "public"."fins_de_contrat"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "propositions_suppression" ADD CONSTRAINT "propositions_gel_fk" FOREIGN KEY ("tenant_id","gel_id") REFERENCES "public"."gels_litige"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reglages_fin_de_contrat" ADD CONSTRAINT "reglages_organisation_fk" FOREIGN KEY ("tenant_id","organisation_id") REFERENCES "public"."organisations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "versions_structure" ADD CONSTRAINT "versions_structure_base_fk" FOREIGN KEY ("tenant_id","base_id") REFERENCES "public"."bases_client"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visibilite_acces" ADD CONSTRAINT "visibilite_organisation_fk" FOREIGN KEY ("tenant_id","organisation_id") REFERENCES "public"."organisations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attestations_fin_de_contrat_tenant_id_idx" ON "attestations_fin_de_contrat" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "bases_client_tenant_id_idx" ON "bases_client" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "confirmations_mise_a_l_ecart_tenant_id_idx" ON "confirmations_mise_a_l_ecart" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "decisions_effacement_tenant_id_idx" ON "decisions_effacement" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "demandes_effacement_tenant_id_idx" ON "demandes_effacement" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "fins_de_contrat_tenant_id_idx" ON "fins_de_contrat" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "gels_litige_tenant_id_idx" ON "gels_litige" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "propositions_suppression_tenant_id_idx" ON "propositions_suppression" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "reglages_fin_de_contrat_tenant_id_idx" ON "reglages_fin_de_contrat" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "versions_structure_tenant_id_idx" ON "versions_structure" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "visibilite_acces_tenant_id_idx" ON "visibilite_acces" USING btree ("tenant_id");-- Partie écrite à la main (drizzle-kit ne génère ni RLS, ni droits, ni déclencheurs), dans la même migration que les tables (ADR 0044).
-- Droits : aucun DELETE ni TRUNCATE, aucun droit pour PUBLIC. Le rôle du portail n'existe pas dans la base console : il n'a donc aucun droit ici (C-715).
-- Ajout seul = pas de droit UPDATE. gels_litige : seule la levée se modifie (colonnes levee_le et leve_par).
ALTER TABLE "public"."bases_client" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."bases_client" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY isolation_client ON "public"."bases_client" FOR ALL TO console_app USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY lecture_equipe ON "public"."bases_client" FOR SELECT TO console_equipe USING (tenant_id IS NOT NULL);--> statement-breakpoint
REVOKE ALL ON TABLE "public"."bases_client" FROM PUBLIC;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "public"."bases_client" TO console_app;--> statement-breakpoint
GRANT SELECT ON TABLE "public"."bases_client" TO console_equipe;--> statement-breakpoint
CREATE TRIGGER bases_client_audit AFTER INSERT OR UPDATE OR DELETE ON "public"."bases_client" FOR EACH ROW EXECUTE FUNCTION public.audit_ecrire();--> statement-breakpoint
ALTER TABLE "public"."versions_structure" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."versions_structure" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY isolation_client ON "public"."versions_structure" FOR ALL TO console_app USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY lecture_equipe ON "public"."versions_structure" FOR SELECT TO console_equipe USING (tenant_id IS NOT NULL);--> statement-breakpoint
REVOKE ALL ON TABLE "public"."versions_structure" FROM PUBLIC;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "public"."versions_structure" TO console_app;--> statement-breakpoint
GRANT SELECT ON TABLE "public"."versions_structure" TO console_equipe;--> statement-breakpoint
CREATE TRIGGER versions_structure_audit AFTER INSERT OR UPDATE OR DELETE ON "public"."versions_structure" FOR EACH ROW EXECUTE FUNCTION public.audit_ecrire();--> statement-breakpoint
ALTER TABLE "public"."fins_de_contrat" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."fins_de_contrat" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY isolation_client ON "public"."fins_de_contrat" FOR ALL TO console_app USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY lecture_equipe ON "public"."fins_de_contrat" FOR SELECT TO console_equipe USING (tenant_id IS NOT NULL);--> statement-breakpoint
REVOKE ALL ON TABLE "public"."fins_de_contrat" FROM PUBLIC;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "public"."fins_de_contrat" TO console_app;--> statement-breakpoint
GRANT SELECT ON TABLE "public"."fins_de_contrat" TO console_equipe;--> statement-breakpoint
CREATE TRIGGER fins_de_contrat_audit AFTER INSERT OR UPDATE OR DELETE ON "public"."fins_de_contrat" FOR EACH ROW EXECUTE FUNCTION public.audit_ecrire();--> statement-breakpoint
ALTER TABLE "public"."confirmations_mise_a_l_ecart" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."confirmations_mise_a_l_ecart" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY isolation_client ON "public"."confirmations_mise_a_l_ecart" FOR ALL TO console_app USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY lecture_equipe ON "public"."confirmations_mise_a_l_ecart" FOR SELECT TO console_equipe USING (tenant_id IS NOT NULL);--> statement-breakpoint
REVOKE ALL ON TABLE "public"."confirmations_mise_a_l_ecart" FROM PUBLIC;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "public"."confirmations_mise_a_l_ecart" TO console_app;--> statement-breakpoint
GRANT SELECT ON TABLE "public"."confirmations_mise_a_l_ecart" TO console_equipe;--> statement-breakpoint
CREATE TRIGGER confirmations_mise_a_l_ecart_audit AFTER INSERT OR UPDATE OR DELETE ON "public"."confirmations_mise_a_l_ecart" FOR EACH ROW EXECUTE FUNCTION public.audit_ecrire();--> statement-breakpoint
ALTER TABLE "public"."demandes_effacement" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."demandes_effacement" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY isolation_client ON "public"."demandes_effacement" FOR ALL TO console_app USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY lecture_equipe ON "public"."demandes_effacement" FOR SELECT TO console_equipe USING (tenant_id IS NOT NULL);--> statement-breakpoint
REVOKE ALL ON TABLE "public"."demandes_effacement" FROM PUBLIC;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "public"."demandes_effacement" TO console_app;--> statement-breakpoint
GRANT SELECT ON TABLE "public"."demandes_effacement" TO console_equipe;--> statement-breakpoint
CREATE TRIGGER demandes_effacement_audit AFTER INSERT OR UPDATE OR DELETE ON "public"."demandes_effacement" FOR EACH ROW EXECUTE FUNCTION public.audit_ecrire();--> statement-breakpoint
ALTER TABLE "public"."decisions_effacement" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."decisions_effacement" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY isolation_client ON "public"."decisions_effacement" FOR ALL TO console_app USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY lecture_equipe ON "public"."decisions_effacement" FOR SELECT TO console_equipe USING (tenant_id IS NOT NULL);--> statement-breakpoint
REVOKE ALL ON TABLE "public"."decisions_effacement" FROM PUBLIC;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "public"."decisions_effacement" TO console_app;--> statement-breakpoint
GRANT SELECT ON TABLE "public"."decisions_effacement" TO console_equipe;--> statement-breakpoint
CREATE TRIGGER decisions_effacement_audit AFTER INSERT OR UPDATE OR DELETE ON "public"."decisions_effacement" FOR EACH ROW EXECUTE FUNCTION public.audit_ecrire();--> statement-breakpoint
ALTER TABLE "public"."propositions_suppression" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."propositions_suppression" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY isolation_client ON "public"."propositions_suppression" FOR ALL TO console_app USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY lecture_equipe ON "public"."propositions_suppression" FOR SELECT TO console_equipe USING (tenant_id IS NOT NULL);--> statement-breakpoint
REVOKE ALL ON TABLE "public"."propositions_suppression" FROM PUBLIC;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "public"."propositions_suppression" TO console_app;--> statement-breakpoint
GRANT SELECT ON TABLE "public"."propositions_suppression" TO console_equipe;--> statement-breakpoint
CREATE TRIGGER propositions_suppression_audit AFTER INSERT OR UPDATE OR DELETE ON "public"."propositions_suppression" FOR EACH ROW EXECUTE FUNCTION public.audit_ecrire();--> statement-breakpoint
ALTER TABLE "public"."reglages_fin_de_contrat" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."reglages_fin_de_contrat" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY isolation_client ON "public"."reglages_fin_de_contrat" FOR ALL TO console_app USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY lecture_equipe ON "public"."reglages_fin_de_contrat" FOR SELECT TO console_equipe USING (tenant_id IS NOT NULL);--> statement-breakpoint
REVOKE ALL ON TABLE "public"."reglages_fin_de_contrat" FROM PUBLIC;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "public"."reglages_fin_de_contrat" TO console_app;--> statement-breakpoint
GRANT SELECT ON TABLE "public"."reglages_fin_de_contrat" TO console_equipe;--> statement-breakpoint
CREATE TRIGGER reglages_fin_de_contrat_audit AFTER INSERT OR UPDATE OR DELETE ON "public"."reglages_fin_de_contrat" FOR EACH ROW EXECUTE FUNCTION public.audit_ecrire();--> statement-breakpoint
ALTER TABLE "public"."attestations_fin_de_contrat" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."attestations_fin_de_contrat" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY isolation_client ON "public"."attestations_fin_de_contrat" FOR ALL TO console_app USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY lecture_equipe ON "public"."attestations_fin_de_contrat" FOR SELECT TO console_equipe USING (tenant_id IS NOT NULL);--> statement-breakpoint
REVOKE ALL ON TABLE "public"."attestations_fin_de_contrat" FROM PUBLIC;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "public"."attestations_fin_de_contrat" TO console_app;--> statement-breakpoint
GRANT SELECT ON TABLE "public"."attestations_fin_de_contrat" TO console_equipe;--> statement-breakpoint
CREATE TRIGGER attestations_fin_de_contrat_audit AFTER INSERT OR UPDATE OR DELETE ON "public"."attestations_fin_de_contrat" FOR EACH ROW EXECUTE FUNCTION public.audit_ecrire();--> statement-breakpoint
ALTER TABLE "public"."gels_litige" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."gels_litige" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY isolation_client ON "public"."gels_litige" FOR ALL TO console_app USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY lecture_equipe ON "public"."gels_litige" FOR SELECT TO console_equipe USING (tenant_id IS NOT NULL);--> statement-breakpoint
REVOKE ALL ON TABLE "public"."gels_litige" FROM PUBLIC;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "public"."gels_litige" TO console_app;--> statement-breakpoint
GRANT SELECT ON TABLE "public"."gels_litige" TO console_equipe;--> statement-breakpoint
GRANT UPDATE ("levee_le", "leve_par") ON TABLE "public"."gels_litige" TO console_app;--> statement-breakpoint
CREATE TRIGGER gels_litige_audit AFTER INSERT OR UPDATE OR DELETE ON "public"."gels_litige" FOR EACH ROW EXECUTE FUNCTION public.audit_ecrire();--> statement-breakpoint
ALTER TABLE "public"."visibilite_acces" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."visibilite_acces" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY isolation_client ON "public"."visibilite_acces" FOR ALL TO console_app USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY lecture_equipe ON "public"."visibilite_acces" FOR SELECT TO console_equipe USING (tenant_id IS NOT NULL);--> statement-breakpoint
REVOKE ALL ON TABLE "public"."visibilite_acces" FROM PUBLIC;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "public"."visibilite_acces" TO console_app;--> statement-breakpoint
GRANT SELECT ON TABLE "public"."visibilite_acces" TO console_equipe;--> statement-breakpoint
CREATE TRIGGER visibilite_acces_audit AFTER INSERT OR UPDATE OR DELETE ON "public"."visibilite_acces" FOR EACH ROW EXECUTE FUNCTION public.audit_ecrire();--> statement-breakpoint
-- Transitions d'état d'une proposition (C-715) : seules en_attente→acceptee, en_attente→ecartee, ecartee→reexamen, acceptee→executee. reexamen et executee sont finaux.
CREATE OR REPLACE FUNCTION public.propositions_transition() RETURNS trigger LANGUAGE plpgsql AS $f$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.id IS DISTINCT FROM OLD.id OR NEW.fin_de_contrat_id IS DISTINCT FROM OLD.fin_de_contrat_id OR NEW.echeance IS DISTINCT FROM OLD.echeance THEN
    RAISE EXCEPTION 'proposition : identité, fin de contrat et échéance ne changent pas' USING ERRCODE = '23514';
  END IF;
  IF NEW.etat IS DISTINCT FROM OLD.etat AND (OLD.etat::text, NEW.etat::text) NOT IN (('en_attente', 'acceptee'), ('en_attente', 'ecartee'), ('ecartee', 'reexamen'), ('acceptee', 'executee')) THEN
    RAISE EXCEPTION 'proposition : transition % vers % refusée', OLD.etat, NEW.etat USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$f$;--> statement-breakpoint
CREATE TRIGGER propositions_transition BEFORE UPDATE ON "public"."propositions_suppression" FOR EACH ROW EXECUTE FUNCTION public.propositions_transition();--> statement-breakpoint
-- Décision d'effacement pour litige : le gel désigné doit exister chez ce client et être actif à la date de la décision (C-715).
CREATE OR REPLACE FUNCTION public.decisions_controle_gel() RETURNS trigger LANGUAGE plpgsql AS $f$
BEGIN
  IF NEW.cause = 'litige_en_cours' AND NOT EXISTS (
    SELECT 1 FROM public.gels_litige g WHERE g.tenant_id = NEW.tenant_id AND g.id = NEW.gel_id AND g.posee_le <= NEW.decidee_le AND (g.levee_le IS NULL OR g.levee_le > NEW.decidee_le)
  ) THEN
    RAISE EXCEPTION 'décision : le gel désigné n''est pas actif à la date de la décision' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$f$;--> statement-breakpoint
CREATE TRIGGER decisions_controle_gel BEFORE INSERT ON "public"."decisions_effacement" FOR EACH ROW EXECUTE FUNCTION public.decisions_controle_gel();
