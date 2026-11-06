-- T3-05b (ADR 0115) : conformité, sous-traitants ultérieurs, signatures de fiches, historique des grilles de prix. ADDITIVE. Numéro 0021 (après 0020 de T3-05a).
-- Aucune fonction nouvelle ; ni suppression, ni vidage, ni changement de type. Échec fermé : une ligne hors contrainte fait échouer la transaction entière.
-- C-034 : demandes_droits, incidents_violations et aipd ne portent aucun texte libre (dates, énumérations, références de forme fermée).
-- automatisations.lit_contenu (C-616) n'est PAS dans cette migration : catalogue.ts est hors fiche (ESCALADE E1), dette T3-05b-dette-lit-contenu.
CREATE TYPE "public"."champ_grille_prix" AS ENUM('installation', 'mensuel', 'maintenance_ensuite', 'maintenance_incluse_mois');--> statement-breakpoint
CREATE TYPE "public"."nature_demande_droits" AS ENUM('acces', 'rectification', 'effacement', 'limitation', 'portabilite', 'opposition');--> statement-breakpoint
CREATE TYPE "public"."niveau_violation" AS ENUM('faible', 'moyen', 'eleve');--> statement-breakpoint
CREATE TYPE "public"."statut_aipd" AS ENUM('a_faire', 'en_cours', 'validee', 'a_revoir');--> statement-breakpoint
CREATE TYPE "public"."statut_demande_droits" AS ENUM('recue', 'en_cours', 'repondue', 'refusee');--> statement-breakpoint
CREATE TYPE "public"."statut_violation" AS ENUM('ouverte', 'notifiee', 'close');--> statement-breakpoint
CREATE TABLE "aipd" (
	"tenant_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"organisation_id" uuid NOT NULL,
	"automatisation_id" uuid NOT NULL,
	"statut" "statut_aipd" DEFAULT 'a_faire' NOT NULL,
	"ouverte_le" timestamp with time zone DEFAULT now() NOT NULL,
	"echeance_le" date NOT NULL,
	"validee_le" timestamp with time zone,
	"revue_le" date,
	"reference_document" text,
	CONSTRAINT "aipd_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "aipd_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "aipd_document_forme" CHECK ("aipd"."reference_document" IS NULL OR ("aipd"."reference_document" ~ '^[A-Za-z0-9][A-Za-z0-9_./-]{0,254}$' AND "aipd"."reference_document" !~ '\.\.')),
	CONSTRAINT "aipd_validation_coherente" CHECK (("aipd"."validee_le" IS NULL) = ("aipd"."statut" <> 'validee'))
);
--> statement-breakpoint
CREATE TABLE "demandes_droits" (
	"tenant_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"organisation_id" uuid NOT NULL,
	"reference" text NOT NULL,
	"nature" "nature_demande_droits" NOT NULL,
	"statut" "statut_demande_droits" DEFAULT 'recue' NOT NULL,
	"demande_id" uuid,
	"recue_le" timestamp with time zone NOT NULL,
	"echeance_le" date NOT NULL,
	"repondue_le" timestamp with time zone,
	"reference_reponse" text,
	"cree_le" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "demandes_droits_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "demandes_droits_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "demandes_droits_reference_unique" UNIQUE("tenant_id","reference"),
	CONSTRAINT "demandes_droits_reference_forme" CHECK ("demandes_droits"."reference" ~ '^droits:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
	CONSTRAINT "demandes_droits_reference_longueur" CHECK (char_length("demandes_droits"."reference") <= 64),
	CONSTRAINT "demandes_droits_reponse_forme" CHECK ("demandes_droits"."reference_reponse" IS NULL OR "demandes_droits"."reference_reponse" ~ '^[A-Za-z0-9][A-Za-z0-9_./:-]{0,127}$'),
	CONSTRAINT "demandes_droits_echeance_apres_reception" CHECK ("demandes_droits"."echeance_le" >= ("demandes_droits"."recue_le" AT TIME ZONE 'Europe/Paris')::date),
	CONSTRAINT "demandes_droits_reponse_coherente" CHECK (("demandes_droits"."repondue_le" IS NULL) = ("demandes_droits"."statut" IN ('recue', 'en_cours')))
);
--> statement-breakpoint
CREATE TABLE "historique_grilles_prix" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"grille_id" uuid NOT NULL,
	"grille_precedente_id" uuid,
	"champ" "champ_grille_prix" NOT NULL,
	"ancienne_valeur_centimes" bigint,
	"nouvelle_valeur_centimes" bigint NOT NULL,
	"auteur" text NOT NULL,
	"raison" text NOT NULL,
	"cree_le" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "historique_grilles_prix_champ_unique" UNIQUE("grille_id","champ"),
	CONSTRAINT "historique_grilles_prix_valeurs_positives" CHECK (("historique_grilles_prix"."ancienne_valeur_centimes" IS NULL OR "historique_grilles_prix"."ancienne_valeur_centimes" >= 0) AND "historique_grilles_prix"."nouvelle_valeur_centimes" >= 0),
	CONSTRAINT "historique_grilles_prix_precedente_distincte" CHECK ("historique_grilles_prix"."grille_precedente_id" IS NULL OR "historique_grilles_prix"."grille_precedente_id" <> "historique_grilles_prix"."grille_id"),
	CONSTRAINT "historique_grilles_prix_auteur_borne" CHECK (length(btrim("historique_grilles_prix"."auteur")) > 0 AND char_length("historique_grilles_prix"."auteur") <= 200),
	CONSTRAINT "historique_grilles_prix_raison_borne" CHECK (length(btrim("historique_grilles_prix"."raison")) > 0 AND char_length("historique_grilles_prix"."raison") <= 500)
);
--> statement-breakpoint
CREATE TABLE "incidents_violations" (
	"tenant_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"organisation_id" uuid NOT NULL,
	"reference" text NOT NULL,
	"niveau" "niveau_violation" NOT NULL,
	"statut" "statut_violation" DEFAULT 'ouverte' NOT NULL,
	"demande_id" uuid,
	"detecte_le" timestamp with time zone NOT NULL,
	"echeance_notification_le" timestamp with time zone NOT NULL,
	"notifie_autorite_le" timestamp with time zone,
	"notifie_personnes_le" timestamp with time zone,
	"reference_dossier" text,
	"close_le" timestamp with time zone,
	"cree_le" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "incidents_violations_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "incidents_violations_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "incidents_violations_reference_unique" UNIQUE("tenant_id","reference"),
	CONSTRAINT "incidents_violations_reference_forme" CHECK ("incidents_violations"."reference" ~ '^violation:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
	CONSTRAINT "incidents_violations_reference_longueur" CHECK (char_length("incidents_violations"."reference") <= 64),
	CONSTRAINT "incidents_violations_dossier_forme" CHECK ("incidents_violations"."reference_dossier" IS NULL OR "incidents_violations"."reference_dossier" ~ '^[A-Za-z0-9][A-Za-z0-9_./:-]{0,127}$'),
	CONSTRAINT "incidents_violations_echeance_apres_detection" CHECK ("incidents_violations"."echeance_notification_le" > "incidents_violations"."detecte_le"),
	CONSTRAINT "incidents_violations_cloture" CHECK (("incidents_violations"."close_le" IS NULL) = ("incidents_violations"."statut" <> 'close'))
);
--> statement-breakpoint
CREATE TABLE "registre_client" (
	"tenant_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"organisation_id" uuid NOT NULL,
	"traitement_id" uuid NOT NULL,
	"fournisseur_ia_code" text,
	"fournisseur_ia_du_client" boolean DEFAULT false NOT NULL,
	"refus_transfert_hors_ue" boolean DEFAULT true NOT NULL,
	"cree_le" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "registre_client_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "registre_client_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "registre_client_traitement_unique" UNIQUE("tenant_id","organisation_id","traitement_id"),
	CONSTRAINT "registre_client_fournisseur_code" CHECK ("registre_client"."fournisseur_ia_code" IS NULL OR "registre_client"."fournisseur_ia_code" ~ '^[a-z][a-z0-9_.-]{0,63}$'),
	CONSTRAINT "registre_client_fournisseur_coherent" CHECK (NOT "registre_client"."fournisseur_ia_du_client" OR "registre_client"."fournisseur_ia_code" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "signatures_fiches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fiche" text NOT NULL,
	"version" integer NOT NULL,
	"empreinte_sha256" text NOT NULL,
	"signee_par" text NOT NULL,
	"signee_le" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "signatures_fiches_fiche_version_unique" UNIQUE("fiche","version"),
	CONSTRAINT "signatures_fiches_fiche_code" CHECK ("signatures_fiches"."fiche" ~ '^[a-z][a-z0-9_.-]{0,63}$'),
	CONSTRAINT "signatures_fiches_version_positive" CHECK ("signatures_fiches"."version" >= 1),
	CONSTRAINT "signatures_fiches_empreinte_forme" CHECK ("signatures_fiches"."empreinte_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "signatures_fiches_signee_par_borne" CHECK (length(btrim("signatures_fiches"."signee_par")) > 0 AND char_length("signatures_fiches"."signee_par") <= 200)
);
--> statement-breakpoint
CREATE TABLE "sous_traitants_ulterieurs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"nom" text NOT NULL,
	"service" text NOT NULL,
	"pays" text NOT NULL,
	"annonce_le" date NOT NULL,
	"date_effet" date NOT NULL,
	"ajoute_par" text NOT NULL,
	"ajoute_le" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sous_traitants_ulterieurs_nom_service_unique" UNIQUE("nom","service"),
	CONSTRAINT "sous_traitants_ulterieurs_nom_borne" CHECK (length(btrim("sous_traitants_ulterieurs"."nom")) > 0 AND char_length("sous_traitants_ulterieurs"."nom") <= 200),
	CONSTRAINT "sous_traitants_ulterieurs_service_borne" CHECK (length(btrim("sous_traitants_ulterieurs"."service")) > 0 AND char_length("sous_traitants_ulterieurs"."service") <= 200),
	CONSTRAINT "sous_traitants_ulterieurs_pays_iso" CHECK ("sous_traitants_ulterieurs"."pays" ~ '^[A-Z]{2}$'),
	CONSTRAINT "sous_traitants_ulterieurs_effet_30_jours" CHECK ("sous_traitants_ulterieurs"."date_effet" >= "sous_traitants_ulterieurs"."annonce_le" + 30),
	CONSTRAINT "sous_traitants_ulterieurs_ajoute_par_borne" CHECK (length(btrim("sous_traitants_ulterieurs"."ajoute_par")) > 0 AND char_length("sous_traitants_ulterieurs"."ajoute_par") <= 200)
);
--> statement-breakpoint
ALTER TABLE "aipd" ADD CONSTRAINT "aipd_automatisation_id_automatisations_id_fk" FOREIGN KEY ("automatisation_id") REFERENCES "public"."automatisations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "aipd" ADD CONSTRAINT "aipd_organisation_fk" FOREIGN KEY ("tenant_id","organisation_id") REFERENCES "public"."organisations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demandes_droits" ADD CONSTRAINT "demandes_droits_organisation_fk" FOREIGN KEY ("tenant_id","organisation_id") REFERENCES "public"."organisations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demandes_droits" ADD CONSTRAINT "demandes_droits_demande_fk" FOREIGN KEY ("tenant_id","demande_id") REFERENCES "public"."demandes"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "historique_grilles_prix" ADD CONSTRAINT "historique_grilles_prix_grille_id_grilles_prix_id_fk" FOREIGN KEY ("grille_id") REFERENCES "public"."grilles_prix"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "historique_grilles_prix" ADD CONSTRAINT "historique_grilles_prix_grille_precedente_id_grilles_prix_id_fk" FOREIGN KEY ("grille_precedente_id") REFERENCES "public"."grilles_prix"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents_violations" ADD CONSTRAINT "incidents_violations_organisation_fk" FOREIGN KEY ("tenant_id","organisation_id") REFERENCES "public"."organisations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents_violations" ADD CONSTRAINT "incidents_violations_demande_fk" FOREIGN KEY ("tenant_id","demande_id") REFERENCES "public"."demandes"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registre_client" ADD CONSTRAINT "registre_client_traitement_id_registre_traitements_id_fk" FOREIGN KEY ("traitement_id") REFERENCES "public"."registre_traitements"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registre_client" ADD CONSTRAINT "registre_client_organisation_fk" FOREIGN KEY ("tenant_id","organisation_id") REFERENCES "public"."organisations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "aipd_tenant_id_idx" ON "aipd" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "aipd_une_ouverte" ON "aipd" USING btree ("tenant_id","organisation_id","automatisation_id") WHERE "aipd"."statut" <> 'validee';--> statement-breakpoint
CREATE INDEX "demandes_droits_tenant_id_idx" ON "demandes_droits" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "demandes_droits_echeance_idx" ON "demandes_droits" USING btree ("tenant_id","echeance_le") WHERE "demandes_droits"."repondue_le" IS NULL;--> statement-breakpoint
CREATE INDEX "historique_grilles_prix_grille_idx" ON "historique_grilles_prix" USING btree ("grille_id","cree_le");--> statement-breakpoint
CREATE INDEX "incidents_violations_tenant_id_idx" ON "incidents_violations" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "incidents_violations_echeance_idx" ON "incidents_violations" USING btree ("tenant_id","echeance_notification_le") WHERE "incidents_violations"."notifie_autorite_le" IS NULL;--> statement-breakpoint
CREATE INDEX "registre_client_tenant_id_idx" ON "registre_client" USING btree ("tenant_id");--> statement-breakpoint

-- ===== Partie écrite à la main (drizzle-kit ne génère ni RLS, ni droits, ni déclencheurs). Aucune fonction nouvelle. =====
-- Quatre tables PAR CLIENT : modèle RLS (ops/socle/postgres/modele-politique-rls.sql), acteur obligatoire, UPDATE par colonnes, aucun DELETE.

ALTER TABLE "public"."registre_client" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."registre_client" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY isolation_client ON "public"."registre_client" FOR ALL TO console_app USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY lecture_equipe ON "public"."registre_client" FOR SELECT TO console_equipe USING (tenant_id IS NOT NULL);--> statement-breakpoint
CREATE POLICY acteur_obligatoire_insert ON "public"."registre_client" AS RESTRICTIVE FOR INSERT TO console_app WITH CHECK (NULLIF(current_setting('app.acteur', true), '') IS NOT NULL);--> statement-breakpoint
CREATE POLICY acteur_obligatoire_update ON "public"."registre_client" AS RESTRICTIVE FOR UPDATE TO console_app USING (true) WITH CHECK (NULLIF(current_setting('app.acteur', true), '') IS NOT NULL);--> statement-breakpoint
REVOKE ALL ON TABLE "public"."registre_client" FROM PUBLIC;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "public"."registre_client" TO console_app;--> statement-breakpoint
GRANT UPDATE ("fournisseur_ia_code", "fournisseur_ia_du_client", "refus_transfert_hors_ue") ON TABLE "public"."registre_client" TO console_app;--> statement-breakpoint
GRANT SELECT ON TABLE "public"."registre_client" TO console_equipe;--> statement-breakpoint
CREATE TRIGGER registre_client_audit AFTER INSERT OR UPDATE OR DELETE ON "public"."registre_client" FOR EACH ROW EXECUTE FUNCTION public.audit_ecrire();--> statement-breakpoint
-- demandes_droits : une demande répondue ne se modifie plus ; elle naît « reçue » et sans réponse.

ALTER TABLE "public"."demandes_droits" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."demandes_droits" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY isolation_client ON "public"."demandes_droits" FOR ALL TO console_app USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY lecture_equipe ON "public"."demandes_droits" FOR SELECT TO console_equipe USING (tenant_id IS NOT NULL);--> statement-breakpoint
CREATE POLICY acteur_obligatoire_insert ON "public"."demandes_droits" AS RESTRICTIVE FOR INSERT TO console_app WITH CHECK (NULLIF(current_setting('app.acteur', true), '') IS NOT NULL AND statut = 'recue' AND repondue_le IS NULL);--> statement-breakpoint
CREATE POLICY acteur_obligatoire_update ON "public"."demandes_droits" AS RESTRICTIVE FOR UPDATE TO console_app USING (repondue_le IS NULL) WITH CHECK (NULLIF(current_setting('app.acteur', true), '') IS NOT NULL);--> statement-breakpoint
REVOKE ALL ON TABLE "public"."demandes_droits" FROM PUBLIC;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "public"."demandes_droits" TO console_app;--> statement-breakpoint
GRANT UPDATE ("statut", "echeance_le", "repondue_le", "reference_reponse", "demande_id") ON TABLE "public"."demandes_droits" TO console_app;--> statement-breakpoint
GRANT SELECT ON TABLE "public"."demandes_droits" TO console_equipe;--> statement-breakpoint
CREATE TRIGGER demandes_droits_audit AFTER INSERT OR UPDATE OR DELETE ON "public"."demandes_droits" FOR EACH ROW EXECUTE FUNCTION public.audit_ecrire();--> statement-breakpoint
-- incidents_violations : une violation close ne se modifie plus ; echeance_notification_le N'EST PAS modifiable (on ne repousse pas une échéance de notification).

ALTER TABLE "public"."incidents_violations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."incidents_violations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY isolation_client ON "public"."incidents_violations" FOR ALL TO console_app USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY lecture_equipe ON "public"."incidents_violations" FOR SELECT TO console_equipe USING (tenant_id IS NOT NULL);--> statement-breakpoint
CREATE POLICY acteur_obligatoire_insert ON "public"."incidents_violations" AS RESTRICTIVE FOR INSERT TO console_app WITH CHECK (NULLIF(current_setting('app.acteur', true), '') IS NOT NULL AND statut = 'ouverte');--> statement-breakpoint
CREATE POLICY acteur_obligatoire_update ON "public"."incidents_violations" AS RESTRICTIVE FOR UPDATE TO console_app USING (statut <> 'close') WITH CHECK (NULLIF(current_setting('app.acteur', true), '') IS NOT NULL);--> statement-breakpoint
REVOKE ALL ON TABLE "public"."incidents_violations" FROM PUBLIC;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "public"."incidents_violations" TO console_app;--> statement-breakpoint
GRANT UPDATE ("niveau", "statut", "notifie_autorite_le", "notifie_personnes_le", "reference_dossier", "close_le", "demande_id") ON TABLE "public"."incidents_violations" TO console_app;--> statement-breakpoint
GRANT SELECT ON TABLE "public"."incidents_violations" TO console_equipe;--> statement-breakpoint
CREATE TRIGGER incidents_violations_audit AFTER INSERT OR UPDATE OR DELETE ON "public"."incidents_violations" FOR EACH ROW EXECUTE FUNCTION public.audit_ecrire();--> statement-breakpoint
-- aipd : elle naît « à faire » et sans date de validation.

ALTER TABLE "public"."aipd" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."aipd" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY isolation_client ON "public"."aipd" FOR ALL TO console_app USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY lecture_equipe ON "public"."aipd" FOR SELECT TO console_equipe USING (tenant_id IS NOT NULL);--> statement-breakpoint
CREATE POLICY acteur_obligatoire_insert ON "public"."aipd" AS RESTRICTIVE FOR INSERT TO console_app WITH CHECK (NULLIF(current_setting('app.acteur', true), '') IS NOT NULL AND statut = 'a_faire' AND validee_le IS NULL);--> statement-breakpoint
CREATE POLICY acteur_obligatoire_update ON "public"."aipd" AS RESTRICTIVE FOR UPDATE TO console_app USING (true) WITH CHECK (NULLIF(current_setting('app.acteur', true), '') IS NOT NULL);--> statement-breakpoint
REVOKE ALL ON TABLE "public"."aipd" FROM PUBLIC;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "public"."aipd" TO console_app;--> statement-breakpoint
GRANT UPDATE ("statut", "echeance_le", "validee_le", "revue_le", "reference_document") ON TABLE "public"."aipd" TO console_app;--> statement-breakpoint
GRANT SELECT ON TABLE "public"."aipd" TO console_equipe;--> statement-breakpoint
CREATE TRIGGER aipd_audit AFTER INSERT OR UPDATE OR DELETE ON "public"."aipd" FOR EACH ROW EXECUTE FUNCTION public.audit_ecrire();--> statement-breakpoint

-- Trois tables COMMUNES : console_equipe seul, ajout seul (aucun UPDATE ni DELETE accordé : une correction est une nouvelle ligne), l'auteur est l'acteur, aucun droit pour console_app.

ALTER TABLE "public"."sous_traitants_ulterieurs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."sous_traitants_ulterieurs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY lecture_equipe ON "public"."sous_traitants_ulterieurs" FOR SELECT TO console_equipe USING (true);--> statement-breakpoint
CREATE POLICY ajout_equipe ON "public"."sous_traitants_ulterieurs" FOR INSERT TO console_equipe WITH CHECK (true);--> statement-breakpoint
CREATE POLICY auteur_acteur ON "public"."sous_traitants_ulterieurs" AS RESTRICTIVE FOR INSERT TO console_equipe WITH CHECK (ajoute_par = NULLIF(current_setting('app.acteur', true), ''));--> statement-breakpoint
REVOKE ALL ON TABLE "public"."sous_traitants_ulterieurs" FROM PUBLIC;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "public"."sous_traitants_ulterieurs" TO console_equipe;--> statement-breakpoint
CREATE TRIGGER sous_traitants_ulterieurs_audit AFTER INSERT OR UPDATE OR DELETE ON "public"."sous_traitants_ulterieurs" FOR EACH ROW EXECUTE FUNCTION public.audit_ecrire_equipe();--> statement-breakpoint

ALTER TABLE "public"."signatures_fiches" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."signatures_fiches" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY lecture_equipe ON "public"."signatures_fiches" FOR SELECT TO console_equipe USING (true);--> statement-breakpoint
CREATE POLICY ajout_equipe ON "public"."signatures_fiches" FOR INSERT TO console_equipe WITH CHECK (true);--> statement-breakpoint
CREATE POLICY auteur_acteur ON "public"."signatures_fiches" AS RESTRICTIVE FOR INSERT TO console_equipe WITH CHECK (signee_par = NULLIF(current_setting('app.acteur', true), ''));--> statement-breakpoint
REVOKE ALL ON TABLE "public"."signatures_fiches" FROM PUBLIC;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "public"."signatures_fiches" TO console_equipe;--> statement-breakpoint
CREATE TRIGGER signatures_fiches_audit AFTER INSERT OR UPDATE OR DELETE ON "public"."signatures_fiches" FOR EACH ROW EXECUTE FUNCTION public.audit_ecrire_equipe();--> statement-breakpoint
-- historique_grilles_prix : seule écriture d'argent du lot 3 ; l'acteur est donc toujours une personne.

ALTER TABLE "public"."historique_grilles_prix" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."historique_grilles_prix" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY lecture_equipe ON "public"."historique_grilles_prix" FOR SELECT TO console_equipe USING (true);--> statement-breakpoint
CREATE POLICY ajout_equipe ON "public"."historique_grilles_prix" FOR INSERT TO console_equipe WITH CHECK (true);--> statement-breakpoint
CREATE POLICY auteur_acteur ON "public"."historique_grilles_prix" AS RESTRICTIVE FOR INSERT TO console_equipe WITH CHECK (auteur = NULLIF(current_setting('app.acteur', true), ''));--> statement-breakpoint
REVOKE ALL ON TABLE "public"."historique_grilles_prix" FROM PUBLIC;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "public"."historique_grilles_prix" TO console_equipe;--> statement-breakpoint
CREATE TRIGGER historique_grilles_prix_audit AFTER INSERT OR UPDATE OR DELETE ON "public"."historique_grilles_prix" FOR EACH ROW EXECUTE FUNCTION public.audit_ecrire_equipe();
-- Retour arrière (à la main, jamais par une migration) : REVOKE des droits ajoutés. Tables, colonnes, types, index et contraintes RESTENT (aucune destruction de données).
