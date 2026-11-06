-- T2-52 (ADR 0111, ADR 0114) : migration de durcissement du lot 2. ADDITIVE. Numéro 0019 (0014 rendue, 0018 déjà prise par T4-21).
-- Échec fermé : doublon d'id, code de cellule hors forme C4 ou SIREN à clé fausse => la transaction échoue, aucune ligne modifiée ni supprimée.

-- M1 : unicité de instances.id (exception nominative, ADR 0111)
ALTER TABLE "instances" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();--> statement-breakpoint
CREATE UNIQUE INDEX "instances_id_unique" ON "instances" USING btree ("id");--> statement-breakpoint

-- M5 : forme C4 du code de cellule (s'ajoute à cellules_code_format, qui reste en place)
ALTER TABLE "cellules" ADD CONSTRAINT "cellules_code_forme_c4" CHECK ("cellules"."code" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length("cellules"."code") <= 64) NOT VALID;--> statement-breakpoint
ALTER TABLE "cellules" VALIDATE CONSTRAINT "cellules_code_forme_c4";--> statement-breakpoint

-- M6, M7 : anti-doublon de a_trancher
CREATE UNIQUE INDEX "a_trancher_incoherence_nuit_ouverte_unique" ON "a_trancher" USING btree ("tenant_id", ("donnees_comparaison"->>'cle')) WHERE "etat" = 'ouvert' AND "motif" = 'incoherence_nuit';--> statement-breakpoint
CREATE UNIQUE INDEX "a_trancher_demande_hub_ouverte_unique" ON "a_trancher" USING btree ("tenant_id", ("donnees_comparaison"->>'idDemande')) WHERE "etat" = 'ouvert' AND "source" = 'hub' AND "donnees_comparaison" ? 'idDemande';--> statement-breakpoint

-- M8, M9 : index des lectures périodiques
CREATE INDEX "boite_envoi_dues_idx" ON "boite_envoi" USING btree ("destination", "cree_le") WHERE "etat" IN ('a_envoyer', 'en_cours');--> statement-breakpoint
CREATE INDEX "alertes_c3_non_confirmees_idx" ON "alertes_c3" USING btree ("tenant_id", "cree_le") WHERE "confirmee_le" IS NULL;--> statement-breakpoint

-- M10 : motif de levée du gel pour litige
ALTER TABLE "gels_litige" ADD COLUMN "motif_levee" text;--> statement-breakpoint
ALTER TABLE "gels_litige" ADD CONSTRAINT "gels_litige_motif_levee_borne" CHECK ("gels_litige"."motif_levee" IS NULL OR (length(btrim("gels_litige"."motif_levee")) > 0 AND char_length("gels_litige"."motif_levee") <= 500));--> statement-breakpoint
-- NOT VALID et jamais validée : les levées anciennes n'ont pas de motif et ne se réécrivent pas (gels_levee_unique) ; la contrainte vaut pour toute écriture nouvelle.
ALTER TABLE "gels_litige" ADD CONSTRAINT "gels_litige_levee_avec_motif" CHECK (("gels_litige"."levee_le" IS NULL) = ("gels_litige"."motif_levee" IS NULL)) NOT VALID;--> statement-breakpoint

-- M11 : clé de Luhn du SIREN des apporteurs (CASE : la conversion n'a lieu que sur 9 chiffres)
ALTER TABLE "apporteurs_clients" ADD CONSTRAINT "apporteurs_clients_siren_luhn" CHECK ("apporteurs_clients"."siren" IS NULL OR CASE WHEN "apporteurs_clients"."siren" ~ '^[0-9]{9}$' THEN (
    substr("siren",1,1)::int + substr("siren",2,1)::int*2%10 + substr("siren",2,1)::int*2/10
  + substr("siren",3,1)::int + substr("siren",4,1)::int*2%10 + substr("siren",4,1)::int*2/10
  + substr("siren",5,1)::int + substr("siren",6,1)::int*2%10 + substr("siren",6,1)::int*2/10
  + substr("siren",7,1)::int + substr("siren",8,1)::int*2%10 + substr("siren",8,1)::int*2/10
  + substr("siren",9,1)::int) % 10 = 0 ELSE false END) NOT VALID;--> statement-breakpoint
ALTER TABLE "apporteurs_clients" VALIDATE CONSTRAINT "apporteurs_clients_siren_luhn";--> statement-breakpoint

-- M12 : longueur maximale des textes (executions est partitionnée : contrainte validée tout de suite, contrôlée sur chaque partition)
ALTER TABLE "executions" ADD CONSTRAINT "executions_auteur_borne" CHECK (char_length("auteur") <= 200);--> statement-breakpoint
ALTER TABLE "executions" ADD CONSTRAINT "executions_termine_par_borne" CHECK ("termine_par" IS NULL OR char_length("termine_par") <= 200);--> statement-breakpoint
ALTER TABLE "alertes" ADD CONSTRAINT "alertes_assignee_borne" CHECK ("alertes"."assignee_a" IS NULL OR char_length("alertes"."assignee_a") <= 200) NOT VALID;--> statement-breakpoint
ALTER TABLE "alertes" VALIDATE CONSTRAINT "alertes_assignee_borne";--> statement-breakpoint

-- M14 : réservation des alertes de quota (par client)
CREATE TABLE "reservations_alertes_quota" (
	"tenant_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"quota" text NOT NULL,
	"seuil" smallint NOT NULL,
	"periode" text NOT NULL,
	"reserve_le" timestamp with time zone,
	"envoye_le" timestamp with time zone,
	CONSTRAINT "reservations_alertes_quota_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "reservations_alertes_quota_cle_unique" UNIQUE("tenant_id","quota","seuil","periode"),
	CONSTRAINT "reservations_alertes_quota_quota" CHECK ("quota" IN ('base', 'fichiers', 'personnes', 'tous')),
	CONSTRAINT "reservations_alertes_quota_seuil" CHECK ("seuil" IN (70, 100)),
	CONSTRAINT "reservations_alertes_quota_periode" CHECK ("periode" ~ '^[0-9]{4}-[0-9]{2}$'),
	CONSTRAINT "reservations_alertes_quota_envoi_reserve" CHECK ("envoye_le" IS NULL OR "reserve_le" IS NOT NULL)
);--> statement-breakpoint
CREATE INDEX "reservations_alertes_quota_tenant_id_idx" ON "reservations_alertes_quota" USING btree ("tenant_id");--> statement-breakpoint

-- ===== Partie écrite à la main (drizzle-kit ne génère ni droits, ni RLS, ni fonctions, ni déclencheurs) =====

-- M2, M3 : droits de console_app sur instances, par colonne (ADR 0111 point 3). DELETE retiré, aucune donnée touchée.
REVOKE INSERT, UPDATE, DELETE ON TABLE "public"."instances" FROM console_app;--> statement-breakpoint
GRANT INSERT ("tenant_id", "organisation_id", "code_automatisation", "formule", "environnement", "etat", "cree_le", "version_courante_id", "automatisation_id", "prereglage_depart_id", "version_prereglage_depart", "instance_source_copie", "copie_le", "copie_par", "plan_commercial", "arret_envois", "version_etat_voulu") ON TABLE "public"."instances" TO console_app;--> statement-breakpoint
GRANT UPDATE ("organisation_id", "code_automatisation", "formule", "environnement", "etat", "version_courante_id", "automatisation_id", "prereglage_depart_id", "version_prereglage_depart", "instance_source_copie", "copie_le", "copie_par", "plan_commercial", "arret_envois", "version_etat_voulu") ON TABLE "public"."instances" TO console_app;--> statement-breakpoint

-- M4 : attribution de cellule réservée à l'équipe ; même erreur que la cellule ou l'instance existe ou non (anti-oracle).
-- Le client vient de app.tenant_id (posé par avecEquipeEcriture), l'acteur de app.acteur. Le propriétaire est soumis à la RLS forcée : politiques dédiées et étroites.
CREATE POLICY lecture_proprietaire ON "public"."instances" FOR SELECT TO console_proprietaire USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY attribution_cellule_proprietaire ON "public"."instances" FOR UPDATE TO console_proprietaire USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY lecture_proprietaire ON "public"."cellules" FOR SELECT TO console_proprietaire USING (true);--> statement-breakpoint
CREATE FUNCTION public.attribuer_cellule(p_instance uuid, p_code text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fonction$
DECLARE
  v_n integer;
BEGIN
  IF NULLIF(current_setting('app.acteur', true), '') IS NULL OR NULLIF(current_setting('app.tenant_id', true), '') IS NULL THEN
    RAISE EXCEPTION 'attribution refusée' USING ERRCODE = 'P0002';
  END IF;
  IF p_code IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.cellules c WHERE c.code = p_code) THEN
    RAISE EXCEPTION 'attribution refusée' USING ERRCODE = 'P0002';
  END IF;
  UPDATE public.instances i SET cellule_code = p_code WHERE i.id = p_instance AND i.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'attribution refusée' USING ERRCODE = 'P0002';
  END IF;
END
$fonction$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.attribuer_cellule(uuid, text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.attribuer_cellule(uuid, text) TO console_equipe;--> statement-breakpoint

-- M10, M11 : droits par colonne
GRANT UPDATE ("motif_levee") ON TABLE "public"."gels_litige" TO console_app;--> statement-breakpoint
GRANT UPDATE ("lu_le") ON TABLE "public"."apporteurs_clients" TO console_app;--> statement-breakpoint

-- M13 : statut final d'une proposition (fonction ordinaire, droits de l'appelant, ne lit aucune table)
CREATE FUNCTION public.propositions_statut_final() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $fonction$
BEGIN
  IF NEW.statut IS DISTINCT FROM OLD.statut AND OLD.statut::text IN ('acceptee', 'refusee', 'expiree') THEN
    RAISE EXCEPTION 'proposition : statut final' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$fonction$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.propositions_statut_final() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER propositions_statut_final BEFORE UPDATE OF statut ON "public"."propositions" FOR EACH ROW EXECUTE FUNCTION public.propositions_statut_final();--> statement-breakpoint

-- M14 : RLS activée ET forcée, aucun DELETE ; « libérer » remet reserve_le à NULL.
ALTER TABLE "public"."reservations_alertes_quota" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."reservations_alertes_quota" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY isolation_client ON "public"."reservations_alertes_quota" FOR ALL TO console_app USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY lecture_equipe ON "public"."reservations_alertes_quota" FOR SELECT TO console_equipe USING (tenant_id IS NOT NULL);--> statement-breakpoint
REVOKE ALL ON TABLE "public"."reservations_alertes_quota" FROM PUBLIC;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "public"."reservations_alertes_quota" TO console_app;--> statement-breakpoint
GRANT UPDATE ("reserve_le", "envoye_le") ON TABLE "public"."reservations_alertes_quota" TO console_app;--> statement-breakpoint
GRANT SELECT ON TABLE "public"."reservations_alertes_quota" TO console_equipe;--> statement-breakpoint
CREATE TRIGGER reservations_alertes_quota_audit AFTER INSERT OR UPDATE OR DELETE ON "public"."reservations_alertes_quota" FOR EACH ROW EXECUTE FUNCTION public.audit_ecrire();
-- Retour arrière (à la main, jamais par une migration) : DROP TRIGGER propositions_statut_final, DROP FUNCTION attribuer_cellule et propositions_statut_final, nouveaux GRANT à refaire.
-- Les colonnes, index, contraintes et la table RESTENT (aucune destruction de données).
