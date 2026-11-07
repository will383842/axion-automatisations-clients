-- T4-27a (ADR 0122) : cycle de vie des versions et preuves de la procédure en 10 étapes. ADDITIVE : aucun DROP, DELETE, TRUNCATE, RENAME ni changement de type. Numéro 0027 (après 0026, T4-54a).
-- Aucune fonction nouvelle (catalogue_garde et audit_ecrire_equipe existent, 0007), aucune valeur d'énumération ajoutée (statut_version a déjà les six états).
-- Échec fermé : une seule transaction ; le CHECK posé sur versions_automatisation (table du lot 2) l'est NOT VALID puis validé.
CREATE TABLE "passages_version" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version_id" uuid NOT NULL,
	"statut_depart" "statut_version" NOT NULL,
	"statut_arrivee" "statut_version" NOT NULL,
	"empreinte_sha256" text NOT NULL,
	"fin_annoncee_le" date,
	"remplacante_id" uuid,
	"prevenance_le" date,
	"auteur" text NOT NULL,
	"passe_le" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "passages_version_transition_permise" CHECK (("passages_version"."statut_depart", "passages_version"."statut_arrivee") IN (('brouillon', 'recette'), ('recette', 'brouillon'), ('recette', 'pilote'), ('pilote', 'publiee'), ('publiee', 'depreciee'), ('depreciee', 'retiree'))),
	CONSTRAINT "passages_version_empreinte_format" CHECK ("passages_version"."empreinte_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "passages_version_depreciation_datee" CHECK (("passages_version"."statut_arrivee" = 'depreciee') = ("passages_version"."fin_annoncee_le" IS NOT NULL)),
	CONSTRAINT "passages_version_retrait_complet" CHECK (("passages_version"."statut_arrivee" = 'retiree') = ("passages_version"."remplacante_id" IS NOT NULL) AND ("passages_version"."statut_arrivee" = 'retiree') = ("passages_version"."prevenance_le" IS NOT NULL)),
	CONSTRAINT "passages_version_remplacante_autre" CHECK ("passages_version"."remplacante_id" IS NULL OR "passages_version"."remplacante_id" <> "passages_version"."version_id"),
	CONSTRAINT "passages_version_dates_bornees" CHECK (("passages_version"."fin_annoncee_le" IS NULL OR "passages_version"."fin_annoncee_le" BETWEEN DATE '2026-01-01' AND DATE '2100-12-31') AND ("passages_version"."prevenance_le" IS NULL OR "passages_version"."prevenance_le" BETWEEN DATE '2026-01-01' AND DATE '2100-12-31')),
	CONSTRAINT "passages_version_auteur_borne" CHECK (length(btrim("passages_version"."auteur")) > 0 AND char_length("passages_version"."auteur") <= 200)
);
--> statement-breakpoint
CREATE TABLE "preuves_procedure" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version_id" uuid NOT NULL,
	"etape" smallint NOT NULL,
	"empreinte_sha256" text NOT NULL,
	"reference" text,
	"mesure_ms" integer,
	"contenu" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"auteur" text NOT NULL,
	"cree_le" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "preuves_procedure_version_etape_empreinte_unique" UNIQUE("version_id","etape","empreinte_sha256"),
	CONSTRAINT "preuves_procedure_etape_bornee" CHECK ("preuves_procedure"."etape" BETWEEN 1 AND 10),
	CONSTRAINT "preuves_procedure_empreinte_format" CHECK ("preuves_procedure"."empreinte_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "preuves_procedure_reference_forme" CHECK ("preuves_procedure"."reference" IS NULL OR ("preuves_procedure"."reference" ~ '^[A-Za-z0-9][A-Za-z0-9_.:/#-]{0,254}$' AND "preuves_procedure"."reference" !~ '\.\.')),
	CONSTRAINT "preuves_procedure_mesure_etape_7" CHECK (("preuves_procedure"."etape" = 7) = ("preuves_procedure"."mesure_ms" IS NOT NULL)),
	CONSTRAINT "preuves_procedure_mesure_bornee" CHECK ("preuves_procedure"."mesure_ms" IS NULL OR "preuves_procedure"."mesure_ms" BETWEEN 1 AND 3600000),
	CONSTRAINT "preuves_procedure_contenu_objet" CHECK (jsonb_typeof("preuves_procedure"."contenu") = 'object' AND octet_length("preuves_procedure"."contenu"::text) <= 8192),
	CONSTRAINT "preuves_procedure_contenu_sans_client" CHECK ("preuves_procedure"."contenu"::text !~* '"[^"]*(tenant|client|organisation|instance|mail|courriel|t[eé]l[eé]phone|phone|siren|siret|iban)[^"]*"[[:space:]]*:' AND "preuves_procedure"."contenu"::text !~* '[^"[:space:]@]+@[^"[:space:]@]+\.[a-z]{2,}' AND "preuves_procedure"."contenu"::text !~ '(^|[^0-9])([0-9]{9}|[0-9]{14})([^0-9]|$)'),
	CONSTRAINT "preuves_procedure_auteur_borne" CHECK (length(btrim("preuves_procedure"."auteur")) > 0 AND char_length("preuves_procedure"."auteur") <= 200)
);
--> statement-breakpoint
ALTER TABLE "versions_automatisation" ADD COLUMN "modeles_testes" text[];--> statement-breakpoint
ALTER TABLE "passages_version" ADD CONSTRAINT "passages_version_version_id_versions_automatisation_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."versions_automatisation"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "passages_version" ADD CONSTRAINT "passages_version_remplacante_id_versions_automatisation_id_fk" FOREIGN KEY ("remplacante_id") REFERENCES "public"."versions_automatisation"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "preuves_procedure" ADD CONSTRAINT "preuves_procedure_version_id_versions_automatisation_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."versions_automatisation"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "passages_version_version_idx" ON "passages_version" USING btree ("version_id","passe_le");--> statement-breakpoint
CREATE INDEX "passages_version_remplacante_idx" ON "passages_version" USING btree ("remplacante_id");--> statement-breakpoint
CREATE INDEX "preuves_procedure_version_idx" ON "preuves_procedure" USING btree ("version_id","etape");--> statement-breakpoint
ALTER TABLE "versions_automatisation" ADD CONSTRAINT "versions_automatisation_modeles_testes_bornes" CHECK ("versions_automatisation"."modeles_testes" IS NULL OR (cardinality("versions_automatisation"."modeles_testes") <= 16 AND array_position("versions_automatisation"."modeles_testes", NULL) IS NULL AND array_to_string("versions_automatisation"."modeles_testes", ',') ~ '^([a-z0-9][a-z0-9._:/-]{0,127}(,[a-z0-9][a-z0-9._:/-]{0,127}){0,15})?$' AND array_to_string("versions_automatisation"."modeles_testes", ',') !~ '\.\.')) NOT VALID;--> statement-breakpoint
ALTER TABLE "versions_automatisation" VALIDATE CONSTRAINT "versions_automatisation_modeles_testes_bornes";--> statement-breakpoint
-- ===== Partie écrite à la main (drizzle-kit ne génère ni RLS, ni droits, ni déclencheurs) : tables communes écrites par l'équipe seule, en ajout seul. =====
ALTER TABLE "public"."preuves_procedure" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."preuves_procedure" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "public"."preuves_procedure" FROM PUBLIC;--> statement-breakpoint
CREATE POLICY lecture_equipe ON "public"."preuves_procedure" FOR SELECT TO console_equipe USING (true);--> statement-breakpoint
CREATE POLICY ajout_equipe ON "public"."preuves_procedure" FOR INSERT TO console_equipe WITH CHECK (true);--> statement-breakpoint
CREATE POLICY auteur_acteur ON "public"."preuves_procedure" AS RESTRICTIVE FOR INSERT TO console_equipe WITH CHECK (auteur = NULLIF(current_setting('app.acteur', true), ''));--> statement-breakpoint
GRANT SELECT ON TABLE "public"."preuves_procedure" TO console_equipe;--> statement-breakpoint
GRANT INSERT ("version_id", "etape", "empreinte_sha256", "reference", "mesure_ms", "contenu", "auteur") ON TABLE "public"."preuves_procedure" TO console_equipe;--> statement-breakpoint
CREATE TRIGGER preuves_procedure_audit AFTER INSERT OR UPDATE OR DELETE ON "public"."preuves_procedure" FOR EACH ROW EXECUTE FUNCTION public.audit_ecrire_equipe();--> statement-breakpoint
CREATE TRIGGER preuves_procedure_sans_suppression BEFORE DELETE ON "public"."preuves_procedure" FOR EACH ROW EXECUTE FUNCTION public.catalogue_garde();--> statement-breakpoint
ALTER TABLE "public"."passages_version" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."passages_version" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "public"."passages_version" FROM PUBLIC;--> statement-breakpoint
CREATE POLICY lecture_equipe ON "public"."passages_version" FOR SELECT TO console_equipe USING (true);--> statement-breakpoint
CREATE POLICY ajout_equipe ON "public"."passages_version" FOR INSERT TO console_equipe WITH CHECK (true);--> statement-breakpoint
CREATE POLICY auteur_acteur ON "public"."passages_version" AS RESTRICTIVE FOR INSERT TO console_equipe WITH CHECK (auteur = NULLIF(current_setting('app.acteur', true), ''));--> statement-breakpoint
GRANT SELECT ON TABLE "public"."passages_version" TO console_equipe;--> statement-breakpoint
GRANT INSERT ("version_id", "statut_depart", "statut_arrivee", "empreinte_sha256", "fin_annoncee_le", "remplacante_id", "prevenance_le", "auteur") ON TABLE "public"."passages_version" TO console_equipe;--> statement-breakpoint
CREATE TRIGGER passages_version_audit AFTER INSERT OR UPDATE OR DELETE ON "public"."passages_version" FOR EACH ROW EXECUTE FUNCTION public.audit_ecrire_equipe();--> statement-breakpoint
CREATE TRIGGER passages_version_sans_suppression BEFORE DELETE ON "public"."passages_version" FOR EACH ROW EXECUTE FUNCTION public.catalogue_garde();--> statement-breakpoint
GRANT UPDATE ("modeles_testes") ON TABLE "public"."versions_automatisation" TO console_equipe;
-- Aucun droit pour console_app, console_lecture ni PUBLIC sur les deux tables ; UPDATE, DELETE et TRUNCATE ne sont accordés à personne. passe_le et cree_le restent hors des droits d'insertion : l'heure est celle du serveur.
-- Retour arrière (documenté, jamais exécuté par la chaîne) : REVOKE seulement ; rien n'est détruit.
