CREATE TYPE "public"."famille_connecteur" AS ENUM('messagerie', 'agenda', 'crm', 'comptabilite', 'stockage', 'signature', 'telephonie', 'autre');--> statement-breakpoint
CREATE TYPE "public"."nature_version" AS ENUM('creation', 'correctif', 'evolution', 'rupture');--> statement-breakpoint
CREATE TYPE "public"."niveau_risque_ia" AS ENUM('sans_ia', 'minimal', 'limite', 'eleve', 'inacceptable');--> statement-breakpoint
CREATE TYPE "public"."origine_automatisation" AS ENUM('axion', 'client', 'partenaire');--> statement-breakpoint
CREATE TYPE "public"."statut_automatisation" AS ENUM('idee', 'en_construction', 'au_catalogue', 'archivee');--> statement-breakpoint
CREATE TYPE "public"."statut_prereglage" AS ENUM('brouillon', 'publie', 'retire');--> statement-breakpoint
CREATE TYPE "public"."statut_version" AS ENUM('brouillon', 'recette', 'pilote', 'publiee', 'depreciee', 'retiree');--> statement-breakpoint
CREATE TYPE "public"."visibilite_automatisation" AS ENUM('interne', 'visible_clients');--> statement-breakpoint
CREATE TABLE "automatisation_metiers" (
	"automatisation_id" uuid NOT NULL,
	"metier_id" uuid NOT NULL,
	CONSTRAINT "automatisation_metiers_automatisation_id_metier_id_pk" PRIMARY KEY("automatisation_id","metier_id")
);
--> statement-breakpoint
CREATE TABLE "automatisation_postes" (
	"automatisation_id" uuid NOT NULL,
	"poste_id" uuid NOT NULL,
	CONSTRAINT "automatisation_postes_automatisation_id_poste_id_pk" PRIMARY KEY("automatisation_id","poste_id")
);
--> statement-breakpoint
CREATE TABLE "automatisations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"nom" text NOT NULL,
	"fonction" text,
	"description" text,
	"visibilite" "visibilite_automatisation" DEFAULT 'interne' NOT NULL,
	"priorite" integer DEFAULT 0 NOT NULL,
	"minutes_gagnees" integer,
	"origine" "origine_automatisation" DEFAULT 'axion' NOT NULL,
	"niveau_risque_ia" "niveau_risque_ia",
	"statut" "statut_automatisation" DEFAULT 'idee' NOT NULL,
	"cree_le" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automatisations_code_unique" UNIQUE("code"),
	CONSTRAINT "automatisations_code_format" CHECK ("automatisations"."code" ~ '^[A-Z]{2,6}-[0-9]{3,5}$'),
	CONSTRAINT "automatisations_nom_non_vide" CHECK (length(btrim("automatisations"."nom")) > 0),
	CONSTRAINT "automatisations_fonction_courte" CHECK ("automatisations"."fonction" IS NULL OR length("automatisations"."fonction") <= 200),
	CONSTRAINT "automatisations_minutes_gagnees_positives" CHECK ("automatisations"."minutes_gagnees" IS NULL OR "automatisations"."minutes_gagnees" >= 0)
);
--> statement-breakpoint
CREATE TABLE "connecteurs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"famille" "famille_connecteur" NOT NULL,
	"outil" text NOT NULL,
	"version" text NOT NULL,
	"capacites" jsonb DEFAULT '[]'::jsonb NOT NULL,
	CONSTRAINT "connecteurs_famille_outil_version_unique" UNIQUE("famille","outil","version"),
	CONSTRAINT "connecteurs_capacites_liste" CHECK (jsonb_typeof("connecteurs"."capacites") = 'array')
);
--> statement-breakpoint
CREATE TABLE "grilles_prix" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"automatisation_id" uuid NOT NULL,
	"formules_actives" jsonb NOT NULL,
	"montant_installation_centimes" bigint NOT NULL,
	"montant_mensuel_centimes" bigint NOT NULL,
	"maintenance_incluse_mois" integer NOT NULL,
	"maintenance_ensuite_centimes" bigint NOT NULL,
	"auteur" text NOT NULL,
	"cree_le" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "grilles_prix_montants_positifs" CHECK ("grilles_prix"."montant_installation_centimes" >= 0 AND "grilles_prix"."montant_mensuel_centimes" >= 0 AND "grilles_prix"."maintenance_ensuite_centimes" >= 0),
	CONSTRAINT "grilles_prix_maintenance_mois_positifs" CHECK ("grilles_prix"."maintenance_incluse_mois" >= 0),
	CONSTRAINT "grilles_prix_auteur_non_vide" CHECK (length(btrim("grilles_prix"."auteur")) > 0),
	CONSTRAINT "grilles_prix_formules_liste" CHECK (jsonb_typeof("grilles_prix"."formules_actives") = 'array')
);
--> statement-breakpoint
CREATE TABLE "metiers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"nom" text NOT NULL,
	"groupe" text NOT NULL,
	"ordre" integer NOT NULL,
	"actif" boolean DEFAULT true NOT NULL,
	CONSTRAINT "metiers_code_unique" UNIQUE("code"),
	CONSTRAINT "metiers_code_format" CHECK ("metiers"."code" ~ '^[a-z][a-z0-9_]{1,62}$'),
	CONSTRAINT "metiers_nom_non_vide" CHECK (length(btrim("metiers"."nom")) > 0)
);
--> statement-breakpoint
CREATE TABLE "packs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"nom" text NOT NULL,
	"metier_id" uuid NOT NULL,
	"prix_centimes" bigint NOT NULL,
	"actif" boolean DEFAULT true NOT NULL,
	"auteur" text NOT NULL,
	"cree_le" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "packs_nom_unique" UNIQUE("nom"),
	CONSTRAINT "packs_prix_positif" CHECK ("packs"."prix_centimes" >= 0),
	CONSTRAINT "packs_nom_non_vide" CHECK (length(btrim("packs"."nom")) > 0),
	CONSTRAINT "packs_auteur_non_vide" CHECK (length(btrim("packs"."auteur")) > 0)
);
--> statement-breakpoint
CREATE TABLE "packs_automatisations" (
	"pack_id" uuid NOT NULL,
	"automatisation_id" uuid NOT NULL,
	CONSTRAINT "packs_automatisations_pack_id_automatisation_id_pk" PRIMARY KEY("pack_id","automatisation_id")
);
--> statement-breakpoint
CREATE TABLE "postes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"nom" text NOT NULL,
	"groupe" text NOT NULL,
	"ordre" integer NOT NULL,
	"actif" boolean DEFAULT true NOT NULL,
	CONSTRAINT "postes_code_unique" UNIQUE("code"),
	CONSTRAINT "postes_code_format" CHECK ("postes"."code" ~ '^[a-z][a-z0-9_]{1,62}$'),
	CONSTRAINT "postes_nom_non_vide" CHECK (length(btrim("postes"."nom")) > 0)
);
--> statement-breakpoint
CREATE TABLE "prereglages_metier" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"automatisation_id" uuid NOT NULL,
	"metier_id" uuid NOT NULL,
	"donnees" jsonb NOT NULL,
	"version" integer NOT NULL,
	"statut" "statut_prereglage" DEFAULT 'brouillon' NOT NULL,
	"auteur" text NOT NULL,
	"justification" text NOT NULL,
	"cree_le" timestamp with time zone DEFAULT now() NOT NULL,
	"version_precedente_id" uuid,
	"module_version_min" text,
	"module_version_max" text,
	CONSTRAINT "prereglages_metier_automatisation_id_metier_id_version_unique" UNIQUE("automatisation_id","metier_id","version"),
	CONSTRAINT "prereglages_metier_version_positive" CHECK ("prereglages_metier"."version" >= 1),
	CONSTRAINT "prereglages_metier_auteur_non_vide" CHECK (length(btrim("prereglages_metier"."auteur")) > 0),
	CONSTRAINT "prereglages_metier_justification_non_vide" CHECK (length(btrim("prereglages_metier"."justification")) > 0),
	CONSTRAINT "prereglages_metier_donnees_objet" CHECK (jsonb_typeof("prereglages_metier"."donnees") = 'object'),
	CONSTRAINT "prereglages_metier_donnees_sans_client" CHECK ("prereglages_metier"."donnees"::text !~* '"[^"]*(tenant|client|organisation|instance|mail|courriel|t[eé]l[eé]phone|phone|siren|siret|iban)[^"]*"[[:space:]]*:' AND "prereglages_metier"."donnees"::text !~* '[^"[:space:]@]+@[^"[:space:]@]+\.[a-z]{2,}' AND "prereglages_metier"."donnees"::text !~ '(^|[^0-9])([0-9]{9}|[0-9]{14})([^0-9]|$)')
);
--> statement-breakpoint
CREATE TABLE "synonymes_catalogue" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mot" text NOT NULL,
	"equivalent" text NOT NULL,
	CONSTRAINT "synonymes_catalogue_mot_equivalent_unique" UNIQUE("mot","equivalent"),
	CONSTRAINT "synonymes_catalogue_non_vides" CHECK (length(btrim("synonymes_catalogue"."mot")) > 0 AND length(btrim("synonymes_catalogue"."equivalent")) > 0 AND "synonymes_catalogue"."mot" <> "synonymes_catalogue"."equivalent")
);
--> statement-breakpoint
CREATE TABLE "versions_automatisation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"automatisation_id" uuid NOT NULL,
	"semver" text NOT NULL,
	"api_moteur" text NOT NULL,
	"artefact_ref" text NOT NULL,
	"empreinte_sha256" text NOT NULL,
	"signature_ed25519" text NOT NULL,
	"sbom_ref" text NOT NULL,
	"nature" "nature_version" DEFAULT 'evolution' NOT NULL,
	"schema_configuration" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"manifeste" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"migration" text,
	"notes" text,
	"statut" "statut_version" DEFAULT 'brouillon' NOT NULL,
	"cree_le" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "versions_automatisation_automatisation_id_semver_unique" UNIQUE("automatisation_id","semver"),
	CONSTRAINT "versions_automatisation_empreinte_sha256_unique" UNIQUE("empreinte_sha256"),
	CONSTRAINT "versions_automatisation_empreinte_format" CHECK ("versions_automatisation"."empreinte_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "versions_automatisation_semver_format" CHECK ("versions_automatisation"."semver" ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$'),
	CONSTRAINT "versions_automatisation_signature_non_vide" CHECK (length(btrim("versions_automatisation"."signature_ed25519")) > 0)
);
--> statement-breakpoint
ALTER TABLE "instances" ADD COLUMN "version_courante_id" uuid;--> statement-breakpoint
ALTER TABLE "instances" ADD COLUMN "automatisation_id" uuid;--> statement-breakpoint
ALTER TABLE "instances" ADD COLUMN "prereglage_depart_id" uuid;--> statement-breakpoint
ALTER TABLE "instances" ADD COLUMN "version_prereglage_depart" integer;--> statement-breakpoint
ALTER TABLE "instances" ADD COLUMN "instance_source_copie" uuid;--> statement-breakpoint
ALTER TABLE "instances" ADD COLUMN "copie_le" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "instances" ADD COLUMN "copie_par" text;--> statement-breakpoint
ALTER TABLE "conditions_par_defaut" ADD COLUMN "auteur" text;--> statement-breakpoint
ALTER TABLE "automatisation_metiers" ADD CONSTRAINT "automatisation_metiers_automatisation_id_automatisations_id_fk" FOREIGN KEY ("automatisation_id") REFERENCES "public"."automatisations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automatisation_metiers" ADD CONSTRAINT "automatisation_metiers_metier_id_metiers_id_fk" FOREIGN KEY ("metier_id") REFERENCES "public"."metiers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automatisation_postes" ADD CONSTRAINT "automatisation_postes_automatisation_id_automatisations_id_fk" FOREIGN KEY ("automatisation_id") REFERENCES "public"."automatisations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automatisation_postes" ADD CONSTRAINT "automatisation_postes_poste_id_postes_id_fk" FOREIGN KEY ("poste_id") REFERENCES "public"."postes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grilles_prix" ADD CONSTRAINT "grilles_prix_automatisation_id_automatisations_id_fk" FOREIGN KEY ("automatisation_id") REFERENCES "public"."automatisations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packs" ADD CONSTRAINT "packs_metier_id_metiers_id_fk" FOREIGN KEY ("metier_id") REFERENCES "public"."metiers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packs_automatisations" ADD CONSTRAINT "packs_automatisations_pack_id_packs_id_fk" FOREIGN KEY ("pack_id") REFERENCES "public"."packs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packs_automatisations" ADD CONSTRAINT "packs_automatisations_automatisation_id_automatisations_id_fk" FOREIGN KEY ("automatisation_id") REFERENCES "public"."automatisations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prereglages_metier" ADD CONSTRAINT "prereglages_metier_automatisation_id_automatisations_id_fk" FOREIGN KEY ("automatisation_id") REFERENCES "public"."automatisations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prereglages_metier" ADD CONSTRAINT "prereglages_metier_metier_id_metiers_id_fk" FOREIGN KEY ("metier_id") REFERENCES "public"."metiers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prereglages_metier" ADD CONSTRAINT "prereglages_metier_version_precedente_fk" FOREIGN KEY ("version_precedente_id") REFERENCES "public"."prereglages_metier"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "versions_automatisation" ADD CONSTRAINT "versions_automatisation_automatisation_id_automatisations_id_fk" FOREIGN KEY ("automatisation_id") REFERENCES "public"."automatisations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "automatisation_metiers_metier_automatisation_idx" ON "automatisation_metiers" USING btree ("metier_id","automatisation_id");--> statement-breakpoint
CREATE INDEX "automatisation_postes_poste_automatisation_idx" ON "automatisation_postes" USING btree ("poste_id","automatisation_id");--> statement-breakpoint
CREATE INDEX "automatisations_statut_idx" ON "automatisations" USING btree ("statut");--> statement-breakpoint
CREATE INDEX "automatisations_visibilite_idx" ON "automatisations" USING btree ("visibilite");--> statement-breakpoint
CREATE INDEX "automatisations_nom_idx" ON "automatisations" USING btree ("nom");--> statement-breakpoint
CREATE INDEX "automatisations_priorite_idx" ON "automatisations" USING btree ("priorite");--> statement-breakpoint
CREATE INDEX "grilles_prix_automatisation_idx" ON "grilles_prix" USING btree ("automatisation_id","cree_le");--> statement-breakpoint
CREATE INDEX "packs_automatisations_automatisation_idx" ON "packs_automatisations" USING btree ("automatisation_id");--> statement-breakpoint
CREATE INDEX "prereglages_metier_metier_idx" ON "prereglages_metier" USING btree ("metier_id","automatisation_id");--> statement-breakpoint
CREATE INDEX "prereglages_metier_automatisation_idx" ON "prereglages_metier" USING btree ("automatisation_id","statut");--> statement-breakpoint
CREATE INDEX "versions_automatisation_automatisation_idx" ON "versions_automatisation" USING btree ("automatisation_id","statut");--> statement-breakpoint
ALTER TABLE "instances" ADD CONSTRAINT "instances_version_courante_id_versions_automatisation_id_fk" FOREIGN KEY ("version_courante_id") REFERENCES "public"."versions_automatisation"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instances" ADD CONSTRAINT "instances_automatisation_id_automatisations_id_fk" FOREIGN KEY ("automatisation_id") REFERENCES "public"."automatisations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instances" ADD CONSTRAINT "instances_prereglage_depart_id_prereglages_metier_id_fk" FOREIGN KEY ("prereglage_depart_id") REFERENCES "public"."prereglages_metier"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instances" ADD CONSTRAINT "instances_copie_complete" CHECK (("instances"."instance_source_copie" IS NULL) = ("instances"."copie_le" IS NULL) AND ("instances"."instance_source_copie" IS NULL) = ("instances"."copie_par" IS NULL));--> statement-breakpoint
ALTER TABLE "conditions_par_defaut" ADD CONSTRAINT "conditions_par_defaut_auteur_non_vide" CHECK (length(btrim("conditions_par_defaut"."auteur")) > 0);--> statement-breakpoint
-- Partie écrite à la main (drizzle-kit ne génère ni RLS, ni droits, ni déclencheurs, ni extensions), dans la même migration que les tables (ADR 0051).
-- Ordre : extensions et fonctions, amorces (AVANT FORCE ROW LEVEL SECURITY : la migration n'a pas de politique d'écriture), index à expression, vue, droits, déclencheurs.
CREATE EXTENSION IF NOT EXISTS unaccent;--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
-- Recherche sans accent (B-533) : unaccent() n'est pas IMMUTABLE, donc inutilisable dans un index ; cette enveloppe l'est (dictionnaire fixé).
CREATE FUNCTION public.sans_accent(texte text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
STRICT
SET search_path = pg_catalog, public
AS $fonction$
  SELECT public.unaccent('public.unaccent'::regdictionary, texte)
$fonction$;--> statement-breakpoint
-- Garde du catalogue : UNE fonction pour tous les déclencheurs (ils valent aussi pour le propriétaire des tables, pas seulement pour console_equipe).
-- Aucune suppression (C-685) ; code d'automatisation figé ; version : aucun contenu ne change dès qu'elle quitte recette, un changement de statut ne change
-- rien d'autre, et seules les transitions de la machine d'états de A-305 passent (publiee → depreciee → retiree, jamais de retour) ; préréglage : naît en
-- brouillon, se rattache à sa version précédente, et son contenu est figé une fois publié ; une version naît en brouillon ; la composition d'un pack se fixe dans la transaction
-- qui le crée.
CREATE FUNCTION public.catalogue_garde()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $fonction$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'catalogue : suppression refusée dans % (une ligne se désactive ou s''archive)', TG_TABLE_NAME;
  END IF;
  IF TG_TABLE_NAME = 'automatisations' THEN
    IF NEW.code IS DISTINCT FROM OLD.code OR NEW.id IS DISTINCT FROM OLD.id THEN
      RAISE EXCEPTION 'catalogue : le code d''une automatisation est figé (jamais réutilisé)';
    END IF;
  ELSIF TG_TABLE_NAME = 'versions_automatisation' THEN
    IF TG_OP = 'INSERT' THEN
      IF NEW.statut <> 'brouillon' THEN
        RAISE EXCEPTION 'catalogue : une version naît en brouillon';
      END IF;
    ELSIF NEW.statut IS DISTINCT FROM OLD.statut THEN
      IF NOT ((OLD.statut, NEW.statut) IN (('brouillon', 'recette'), ('recette', 'brouillon'), ('recette', 'pilote'), ('pilote', 'publiee'), ('publiee', 'depreciee'), ('depreciee', 'retiree'))) THEN
        RAISE EXCEPTION 'catalogue : transition de version refusée (% vers %)', OLD.statut, NEW.statut;
      END IF;
      IF to_jsonb(NEW) - 'statut' <> to_jsonb(OLD) - 'statut' THEN
        RAISE EXCEPTION 'catalogue : un changement de statut ne modifie aucune autre colonne de la version';
      END IF;
    ELSIF to_jsonb(NEW) <> to_jsonb(OLD) AND OLD.statut NOT IN ('brouillon', 'recette') THEN
      RAISE EXCEPTION 'catalogue : version % immuable', OLD.statut;
    END IF;
  ELSIF TG_TABLE_NAME = 'packs_automatisations' THEN
    IF NOT EXISTS (SELECT 1 FROM public.packs p WHERE p.id = NEW.pack_id AND p.cree_le = now()) THEN
      RAISE EXCEPTION 'catalogue : la composition d''un pack est fixée à sa création (même transaction) ; un autre contenu fait un autre pack';
    END IF;
  ELSIF TG_TABLE_NAME = 'prereglages_metier' THEN
    IF TG_OP = 'INSERT' THEN
      IF NEW.statut <> 'brouillon' THEN
        RAISE EXCEPTION 'catalogue : un préréglage naît en brouillon';
      END IF;
      IF NEW.version_precedente_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM public.prereglages_metier p
        WHERE p.id = NEW.version_precedente_id AND p.automatisation_id = NEW.automatisation_id AND p.metier_id = NEW.metier_id AND p.version < NEW.version) THEN
        RAISE EXCEPTION 'catalogue : la version précédente doit être celle du même préréglage, en version plus ancienne';
      END IF;
    ELSE
      IF NOT (OLD.statut = NEW.statut OR (OLD.statut, NEW.statut) IN (('brouillon', 'publie'), ('brouillon', 'retire'), ('publie', 'retire'))) THEN
        RAISE EXCEPTION 'catalogue : transition de préréglage refusée (% vers %)', OLD.statut, NEW.statut;
      END IF;
      IF OLD.statut <> 'brouillon' AND to_jsonb(NEW) - 'statut' <> to_jsonb(OLD) - 'statut' THEN
        RAISE EXCEPTION 'catalogue : préréglage % : contenu figé', OLD.statut;
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END
$fonction$;--> statement-breakpoint
-- Journal d'audit des écritures de l'ÉQUIPE : console_equipe ne peut pas exécuter audit_ajouter (ADR 0050) ; cette fonction SECURITY DEFINER le fait à sa place.
-- Les lignes de l'équipe n'ont pas de client (tenant_id nul au journal) ; l'acteur vient de app.acteur de la transaction, « systeme » à défaut.
CREATE FUNCTION public.audit_ecrire_equipe()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fonction$
DECLARE
  v_acteur text;
  v_ancienne jsonb;
  v_nouvelle jsonb;
  v_ligne jsonb;
  v_copie jsonb;
BEGIN
  v_acteur := NULLIF(current_setting('app.acteur', true), '');
  -- Une écriture qui porte de l'argent a toujours une personne au journal : pas de repli sur « systeme ».
  IF v_acteur IS NULL AND TG_TABLE_NAME IN ('conditions_par_defaut', 'grilles_prix', 'packs', 'packs_automatisations') THEN
    RAISE EXCEPTION 'journal : acteur obligatoire pour une écriture qui porte de l''argent (app.acteur vide)';
  END IF;
  IF TG_OP = 'INSERT' THEN
    v_nouvelle := to_jsonb(NEW);
  ELSIF TG_OP = 'UPDATE' THEN
    v_ancienne := to_jsonb(OLD);
    v_nouvelle := to_jsonb(NEW);
  ELSE
    v_ancienne := to_jsonb(OLD);
  END IF;
  v_ligne := coalesce(v_nouvelle, v_ancienne);
  -- Même borne que audit_ecrire : au-delà de 256 Kio, les valeurs de plus de 64 Kio sont remplacées ; si cela ne suffit pas, toute la copie l'est.
  FOR i IN 1..2 LOOP
    v_copie := CASE i WHEN 1 THEN v_ancienne ELSE v_nouvelle END;
    IF octet_length(v_copie::text) > 262144 THEN
      SELECT jsonb_object_agg(e.key, CASE WHEN octet_length(e.value::text) > 65536 THEN jsonb_build_object('_omis', 'taille', 'octets', octet_length(e.value::text)) ELSE e.value END)
        INTO v_copie FROM jsonb_each(v_copie) e;
      IF octet_length(v_copie::text) > 262144 THEN
        v_copie := jsonb_build_object('_omis', 'taille');
      END IF;
    END IF;
    IF i = 1 THEN v_ancienne := v_copie; ELSE v_nouvelle := v_copie; END IF;
  END LOOP;
  PERFORM public.audit_ajouter(
    NULL,
    coalesce(v_acteur, 'systeme'),
    (CASE TG_OP WHEN 'INSERT' THEN 'insertion' WHEN 'UPDATE' THEN 'modification' ELSE 'suppression' END)::public.action_audit,
    TG_TABLE_NAME::text,
    coalesce(v_ligne ->> 'id', (SELECT string_agg(e.value, '/' ORDER BY e.key) FROM jsonb_each_text(v_ligne) e WHERE right(e.key, 3) = '_id')),
    v_ancienne,
    v_nouvelle);
  RETURN NULL;
END
$fonction$;--> statement-breakpoint
-- audit_ecrire, redéfinie : la copie d'une ligne de `instances` ne recopie JAMAIS les colonnes d'origine (C-676) : console_app lit le journal de son client et ne doit pas y
-- retrouver l'instance d'un autre client ni le nom de la personne de l'équipe. Même corps que la 0003 ; seul le bloc `instances` est ajouté.
CREATE OR REPLACE FUNCTION public.audit_ecrire()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $fonction$
DECLARE
  v_ancienne jsonb;
  v_nouvelle jsonb;
  v_ligne jsonb;
  v_copie jsonb;
  v_omis jsonb := '{"instance_source_copie": {"_omis": "interne"}, "copie_le": {"_omis": "interne"}, "copie_par": {"_omis": "interne"}, "prereglage_depart_id": {"_omis": "interne"}, "version_prereglage_depart": {"_omis": "interne"}}'::jsonb;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_nouvelle := to_jsonb(NEW);
  ELSIF TG_OP = 'UPDATE' THEN
    v_ancienne := to_jsonb(OLD);
    v_nouvelle := to_jsonb(NEW);
  ELSE
    v_ancienne := to_jsonb(OLD);
  END IF;
  IF TG_TABLE_NAME = 'instances' THEN
    IF v_ancienne IS NOT NULL THEN v_ancienne := (v_ancienne - ARRAY['instance_source_copie', 'copie_le', 'copie_par', 'prereglage_depart_id', 'version_prereglage_depart']) || v_omis; END IF;
    IF v_nouvelle IS NOT NULL THEN v_nouvelle := (v_nouvelle - ARRAY['instance_source_copie', 'copie_le', 'copie_par', 'prereglage_depart_id', 'version_prereglage_depart']) || v_omis; END IF;
  END IF;
  v_ligne := coalesce(v_nouvelle, v_ancienne);
  FOR i IN 1..2 LOOP
    v_copie := CASE i WHEN 1 THEN v_ancienne ELSE v_nouvelle END;
    IF octet_length(v_copie::text) > 262144 THEN
      SELECT jsonb_object_agg(e.key, CASE WHEN octet_length(e.value::text) > 65536 THEN jsonb_build_object('_omis', 'taille', 'octets', octet_length(e.value::text)) ELSE e.value END)
        INTO v_copie FROM jsonb_each(v_copie) e;
      IF octet_length(v_copie::text) > 262144 THEN
        v_copie := jsonb_build_object('_omis', 'taille');
      END IF;
    END IF;
    IF i = 1 THEN v_ancienne := v_copie; ELSE v_nouvelle := v_copie; END IF;
  END LOOP;
  PERFORM public.audit_ajouter(
    (v_ligne ->> 'tenant_id')::uuid,
    coalesce(NULLIF(current_setting('app.acteur', true), ''), 'systeme'),
    (CASE TG_OP WHEN 'INSERT' THEN 'insertion' WHEN 'UPDATE' THEN 'modification' ELSE 'suppression' END)::public.action_audit,
    TG_TABLE_NAME::text,
    coalesce(v_ligne ->> 'id', v_ligne ->> 'tenant_id'),
    v_ancienne,
    v_nouvelle);
  RETURN NULL;
END
$fonction$;--> statement-breakpoint
-- Cohérence des colonnes ajoutées à instances (A-126, C-676), contrôlée avec les droits de l'appelant (console_app ne voit que les versions publiées, dépréciées ou retirées,
-- et les préréglages publiés ou retirés : un brouillon est donc inconnu pour lui) : la version courante est une version PUBLIÉE de l'automatisation de l'instance ;
-- le préréglage de départ et sa version vont ensemble, le préréglage est publié, de la même automatisation, à cette version. Les clés étrangères seules ne le garantissent pas.
CREATE FUNCTION public.instances_garde()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $fonction$
DECLARE
  v_naissance boolean := (TG_OP = 'INSERT');
  v_version_change boolean := (TG_OP = 'INSERT');
  v_automatisation_change boolean := (TG_OP = 'INSERT');
  v_prereglage_change boolean := (TG_OP = 'INSERT');
  v_automatisation uuid;
  v_statut_version public.statut_version;
  v_numero integer;
  v_statut_prereglage public.statut_prereglage;
BEGIN
  IF NOT v_naissance THEN
    v_version_change := NEW.version_courante_id IS DISTINCT FROM OLD.version_courante_id;
    v_automatisation_change := NEW.automatisation_id IS DISTINCT FROM OLD.automatisation_id;
    v_prereglage_change := NEW.prereglage_depart_id IS DISTINCT FROM OLD.prereglage_depart_id OR NEW.version_prereglage_depart IS DISTINCT FROM OLD.version_prereglage_depart;
  END IF;
  IF (NEW.prereglage_depart_id IS NULL) <> (NEW.version_prereglage_depart IS NULL) THEN
    RAISE EXCEPTION 'instances : le préréglage de départ et sa version vont ensemble';
  END IF;
  IF NEW.version_courante_id IS NOT NULL AND (v_version_change OR v_automatisation_change) THEN
    SELECT v.automatisation_id, v.statut INTO v_automatisation, v_statut_version FROM public.versions_automatisation v WHERE v.id = NEW.version_courante_id;
    IF NOT FOUND OR v_automatisation IS DISTINCT FROM NEW.automatisation_id THEN
      RAISE EXCEPTION 'instances : la version courante doit être une version de l''automatisation de l''instance';
    END IF;
    IF v_version_change AND v_statut_version <> 'publiee' THEN
      RAISE EXCEPTION 'instances : la version courante doit être une version publiée';
    END IF;
  END IF;
  IF NEW.prereglage_depart_id IS NOT NULL AND (v_prereglage_change OR v_automatisation_change) THEN
    SELECT p.automatisation_id, p.version, p.statut INTO v_automatisation, v_numero, v_statut_prereglage FROM public.prereglages_metier p WHERE p.id = NEW.prereglage_depart_id;
    IF NOT FOUND OR v_automatisation IS DISTINCT FROM NEW.automatisation_id OR v_numero <> NEW.version_prereglage_depart OR v_statut_prereglage <> 'publie' THEN
      RAISE EXCEPTION 'instances : le préréglage de départ doit être publié, de l''automatisation de l''instance, à la version indiquée';
    END IF;
  END IF;
  RETURN NEW;
END
$fonction$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.sans_accent(text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.sans_accent(text) TO console_app, console_equipe;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.catalogue_garde() FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.audit_ecrire_equipe() FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.instances_garde() FROM PUBLIC;--> statement-breakpoint
-- Amorces : les 7 premiers métiers (B-341) et les postes de départ. Le dirigeant en ajoute depuis la console, sans migration (C-670).
INSERT INTO "public"."metiers" ("code", "nom", "groupe", "ordre") VALUES ('btp_artisans', 'BTP et artisans', 'terrain', 10), ('cabinets_comptables', 'Cabinets comptables', 'conseil', 20), ('avocats_conseils', 'Avocats et conseils', 'conseil', 30), ('agences_immobilieres', 'Agences immobilières', 'commerce', 40), ('commerce_ecommerce', 'Commerce et e-commerce', 'commerce', 50), ('industrie_services_b2b', 'Industrie et services B2B', 'industrie_et_logistique', 60), ('transport_logistique', 'Transport et logistique', 'industrie_et_logistique', 70);--> statement-breakpoint
INSERT INTO "public"."postes" ("code", "nom", "groupe", "ordre") VALUES ('direction', 'Direction', 'direction', 10), ('commercial', 'Commercial', 'commercial', 20), ('comptabilite', 'Comptabilité', 'gestion', 30), ('rh', 'RH', 'gestion', 40), ('dsi', 'DSI', 'technique', 50), ('achats', 'Achats', 'gestion', 60), ('production', 'Production', 'operations', 70), ('service_client', 'Service client', 'commercial', 80);--> statement-breakpoint
CREATE UNIQUE INDEX "metiers_nom_sans_casse_ni_accent" ON "public"."metiers" (lower(public.sans_accent("nom")));--> statement-breakpoint
CREATE UNIQUE INDEX "postes_nom_sans_casse_ni_accent" ON "public"."postes" (lower(public.sans_accent("nom")));--> statement-breakpoint
-- Recherche de T3-40 : l'expression de l'index est celle que la requête doit écrire (« prereglage » trouve « préréglage »).
CREATE INDEX "automatisations_recherche_trgm_idx" ON "public"."automatisations" USING gin (lower(public.sans_accent(coalesce("code", '') || ' ' || "nom" || ' ' || coalesce("fonction", '') || ' ' || coalesce("description", ''))) gin_trgm_ops);--> statement-breakpoint
-- Étiquette « outil » (C-671) : calculée depuis les connecteurs déclarés par le manifeste des versions, jamais saisie. Les droits de l'appelant s'appliquent (security_invoker).
CREATE VIEW "public"."automatisation_outils" WITH (security_invoker = true) AS
SELECT DISTINCT v.automatisation_id, c.famille, c.outil
FROM public.versions_automatisation v
CROSS JOIN LATERAL jsonb_to_recordset(CASE WHEN jsonb_typeof(v.manifeste -> 'connecteurs') = 'array' THEN v.manifeste -> 'connecteurs' ELSE '[]'::jsonb END) AS c(famille text, outil text)
WHERE v.statut <> 'retiree' AND c.famille IS NOT NULL AND c.outil IS NOT NULL;--> statement-breakpoint
REVOKE ALL ON TABLE "public"."automatisation_outils" FROM PUBLIC;--> statement-breakpoint
GRANT SELECT ON TABLE "public"."automatisation_outils" TO console_app, console_equipe;--> statement-breakpoint
ALTER TABLE "public"."metiers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."metiers" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY lecture_catalogue ON "public"."metiers" FOR SELECT TO console_app USING (true);--> statement-breakpoint
CREATE POLICY lecture_equipe ON "public"."metiers" FOR SELECT TO console_equipe USING (true);--> statement-breakpoint
CREATE POLICY ajout_equipe ON "public"."metiers" FOR INSERT TO console_equipe WITH CHECK (true);--> statement-breakpoint
CREATE POLICY modification_equipe ON "public"."metiers" FOR UPDATE TO console_equipe USING (true) WITH CHECK (true);--> statement-breakpoint
REVOKE ALL ON TABLE "public"."metiers" FROM PUBLIC;--> statement-breakpoint
GRANT SELECT ON TABLE "public"."metiers" TO console_app;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "public"."metiers" TO console_equipe;--> statement-breakpoint
GRANT UPDATE ("nom", "groupe", "ordre", "actif") ON TABLE "public"."metiers" TO console_equipe;--> statement-breakpoint
CREATE TRIGGER metiers_audit AFTER INSERT OR UPDATE OR DELETE ON "public"."metiers" FOR EACH ROW EXECUTE FUNCTION public.audit_ecrire_equipe();--> statement-breakpoint
ALTER TABLE "public"."postes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."postes" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY lecture_catalogue ON "public"."postes" FOR SELECT TO console_app USING (true);--> statement-breakpoint
CREATE POLICY lecture_equipe ON "public"."postes" FOR SELECT TO console_equipe USING (true);--> statement-breakpoint
CREATE POLICY ajout_equipe ON "public"."postes" FOR INSERT TO console_equipe WITH CHECK (true);--> statement-breakpoint
CREATE POLICY modification_equipe ON "public"."postes" FOR UPDATE TO console_equipe USING (true) WITH CHECK (true);--> statement-breakpoint
REVOKE ALL ON TABLE "public"."postes" FROM PUBLIC;--> statement-breakpoint
GRANT SELECT ON TABLE "public"."postes" TO console_app;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "public"."postes" TO console_equipe;--> statement-breakpoint
GRANT UPDATE ("nom", "groupe", "ordre", "actif") ON TABLE "public"."postes" TO console_equipe;--> statement-breakpoint
CREATE TRIGGER postes_audit AFTER INSERT OR UPDATE OR DELETE ON "public"."postes" FOR EACH ROW EXECUTE FUNCTION public.audit_ecrire_equipe();--> statement-breakpoint
ALTER TABLE "public"."automatisations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."automatisations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY lecture_catalogue ON "public"."automatisations" FOR SELECT TO console_app USING (true);--> statement-breakpoint
CREATE POLICY lecture_equipe ON "public"."automatisations" FOR SELECT TO console_equipe USING (true);--> statement-breakpoint
CREATE POLICY ajout_equipe ON "public"."automatisations" FOR INSERT TO console_equipe WITH CHECK (true);--> statement-breakpoint
CREATE POLICY modification_equipe ON "public"."automatisations" FOR UPDATE TO console_equipe USING (true) WITH CHECK (true);--> statement-breakpoint
REVOKE ALL ON TABLE "public"."automatisations" FROM PUBLIC;--> statement-breakpoint
GRANT SELECT ON TABLE "public"."automatisations" TO console_app;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "public"."automatisations" TO console_equipe;--> statement-breakpoint
GRANT UPDATE ("nom", "fonction", "description", "visibilite", "priorite", "minutes_gagnees", "origine", "niveau_risque_ia", "statut") ON TABLE "public"."automatisations" TO console_equipe;--> statement-breakpoint
CREATE TRIGGER automatisations_audit AFTER INSERT OR UPDATE OR DELETE ON "public"."automatisations" FOR EACH ROW EXECUTE FUNCTION public.audit_ecrire_equipe();--> statement-breakpoint
ALTER TABLE "public"."automatisation_metiers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."automatisation_metiers" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY lecture_catalogue ON "public"."automatisation_metiers" FOR SELECT TO console_app USING (true);--> statement-breakpoint
CREATE POLICY lecture_equipe ON "public"."automatisation_metiers" FOR SELECT TO console_equipe USING (true);--> statement-breakpoint
CREATE POLICY ajout_equipe ON "public"."automatisation_metiers" FOR INSERT TO console_equipe WITH CHECK (true);--> statement-breakpoint
CREATE POLICY suppression_equipe ON "public"."automatisation_metiers" FOR DELETE TO console_equipe USING (true);--> statement-breakpoint
REVOKE ALL ON TABLE "public"."automatisation_metiers" FROM PUBLIC;--> statement-breakpoint
GRANT SELECT ON TABLE "public"."automatisation_metiers" TO console_app;--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON TABLE "public"."automatisation_metiers" TO console_equipe;--> statement-breakpoint
CREATE TRIGGER automatisation_metiers_audit AFTER INSERT OR UPDATE OR DELETE ON "public"."automatisation_metiers" FOR EACH ROW EXECUTE FUNCTION public.audit_ecrire_equipe();--> statement-breakpoint
ALTER TABLE "public"."automatisation_postes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."automatisation_postes" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY lecture_catalogue ON "public"."automatisation_postes" FOR SELECT TO console_app USING (true);--> statement-breakpoint
CREATE POLICY lecture_equipe ON "public"."automatisation_postes" FOR SELECT TO console_equipe USING (true);--> statement-breakpoint
CREATE POLICY ajout_equipe ON "public"."automatisation_postes" FOR INSERT TO console_equipe WITH CHECK (true);--> statement-breakpoint
CREATE POLICY suppression_equipe ON "public"."automatisation_postes" FOR DELETE TO console_equipe USING (true);--> statement-breakpoint
REVOKE ALL ON TABLE "public"."automatisation_postes" FROM PUBLIC;--> statement-breakpoint
GRANT SELECT ON TABLE "public"."automatisation_postes" TO console_app;--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON TABLE "public"."automatisation_postes" TO console_equipe;--> statement-breakpoint
CREATE TRIGGER automatisation_postes_audit AFTER INSERT OR UPDATE OR DELETE ON "public"."automatisation_postes" FOR EACH ROW EXECUTE FUNCTION public.audit_ecrire_equipe();--> statement-breakpoint
ALTER TABLE "public"."versions_automatisation" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."versions_automatisation" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY lecture_catalogue ON "public"."versions_automatisation" FOR SELECT TO console_app USING (statut IN ('publiee', 'depreciee', 'retiree'));--> statement-breakpoint
CREATE POLICY lecture_equipe ON "public"."versions_automatisation" FOR SELECT TO console_equipe USING (true);--> statement-breakpoint
CREATE POLICY ajout_equipe ON "public"."versions_automatisation" FOR INSERT TO console_equipe WITH CHECK (true);--> statement-breakpoint
CREATE POLICY modification_equipe ON "public"."versions_automatisation" FOR UPDATE TO console_equipe USING (true) WITH CHECK (true);--> statement-breakpoint
REVOKE ALL ON TABLE "public"."versions_automatisation" FROM PUBLIC;--> statement-breakpoint
GRANT SELECT ON TABLE "public"."versions_automatisation" TO console_app;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "public"."versions_automatisation" TO console_equipe;--> statement-breakpoint
GRANT UPDATE ("api_moteur", "artefact_ref", "empreinte_sha256", "signature_ed25519", "sbom_ref", "nature", "schema_configuration", "manifeste", "migration", "notes", "statut") ON TABLE "public"."versions_automatisation" TO console_equipe;--> statement-breakpoint
CREATE TRIGGER versions_automatisation_audit AFTER INSERT OR UPDATE OR DELETE ON "public"."versions_automatisation" FOR EACH ROW EXECUTE FUNCTION public.audit_ecrire_equipe();--> statement-breakpoint
ALTER TABLE "public"."prereglages_metier" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."prereglages_metier" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY lecture_catalogue ON "public"."prereglages_metier" FOR SELECT TO console_app USING (statut IN ('publie', 'retire'));--> statement-breakpoint
CREATE POLICY lecture_equipe ON "public"."prereglages_metier" FOR SELECT TO console_equipe USING (true);--> statement-breakpoint
CREATE POLICY ajout_equipe ON "public"."prereglages_metier" FOR INSERT TO console_equipe WITH CHECK (true);--> statement-breakpoint
CREATE POLICY modification_equipe ON "public"."prereglages_metier" FOR UPDATE TO console_equipe USING (true) WITH CHECK (true);--> statement-breakpoint
REVOKE ALL ON TABLE "public"."prereglages_metier" FROM PUBLIC;--> statement-breakpoint
GRANT SELECT ON TABLE "public"."prereglages_metier" TO console_app;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "public"."prereglages_metier" TO console_equipe;--> statement-breakpoint
GRANT UPDATE ("donnees", "statut", "justification") ON TABLE "public"."prereglages_metier" TO console_equipe;--> statement-breakpoint
CREATE TRIGGER prereglages_metier_audit AFTER INSERT OR UPDATE OR DELETE ON "public"."prereglages_metier" FOR EACH ROW EXECUTE FUNCTION public.audit_ecrire_equipe();--> statement-breakpoint
ALTER TABLE "public"."synonymes_catalogue" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."synonymes_catalogue" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY lecture_catalogue ON "public"."synonymes_catalogue" FOR SELECT TO console_app USING (true);--> statement-breakpoint
CREATE POLICY lecture_equipe ON "public"."synonymes_catalogue" FOR SELECT TO console_equipe USING (true);--> statement-breakpoint
CREATE POLICY ajout_equipe ON "public"."synonymes_catalogue" FOR INSERT TO console_equipe WITH CHECK (true);--> statement-breakpoint
CREATE POLICY suppression_equipe ON "public"."synonymes_catalogue" FOR DELETE TO console_equipe USING (true);--> statement-breakpoint
REVOKE ALL ON TABLE "public"."synonymes_catalogue" FROM PUBLIC;--> statement-breakpoint
GRANT SELECT ON TABLE "public"."synonymes_catalogue" TO console_app;--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON TABLE "public"."synonymes_catalogue" TO console_equipe;--> statement-breakpoint
CREATE TRIGGER synonymes_catalogue_audit AFTER INSERT OR UPDATE OR DELETE ON "public"."synonymes_catalogue" FOR EACH ROW EXECUTE FUNCTION public.audit_ecrire_equipe();--> statement-breakpoint
ALTER TABLE "public"."packs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."packs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY lecture_catalogue ON "public"."packs" FOR SELECT TO console_app USING (true);--> statement-breakpoint
CREATE POLICY lecture_equipe ON "public"."packs" FOR SELECT TO console_equipe USING (true);--> statement-breakpoint
CREATE POLICY ajout_equipe ON "public"."packs" FOR INSERT TO console_equipe WITH CHECK (true);--> statement-breakpoint
CREATE POLICY modification_equipe ON "public"."packs" FOR UPDATE TO console_equipe USING (true) WITH CHECK (true);--> statement-breakpoint
REVOKE ALL ON TABLE "public"."packs" FROM PUBLIC;--> statement-breakpoint
GRANT SELECT ON TABLE "public"."packs" TO console_app;--> statement-breakpoint
GRANT SELECT ON TABLE "public"."packs" TO console_equipe;--> statement-breakpoint
GRANT INSERT ("id", "nom", "metier_id", "prix_centimes", "actif", "auteur") ON TABLE "public"."packs" TO console_equipe;--> statement-breakpoint
GRANT UPDATE ("actif") ON TABLE "public"."packs" TO console_equipe;--> statement-breakpoint
CREATE TRIGGER packs_audit AFTER INSERT OR UPDATE OR DELETE ON "public"."packs" FOR EACH ROW EXECUTE FUNCTION public.audit_ecrire_equipe();--> statement-breakpoint
ALTER TABLE "public"."packs_automatisations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."packs_automatisations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY lecture_catalogue ON "public"."packs_automatisations" FOR SELECT TO console_app USING (true);--> statement-breakpoint
CREATE POLICY lecture_equipe ON "public"."packs_automatisations" FOR SELECT TO console_equipe USING (true);--> statement-breakpoint
CREATE POLICY ajout_equipe ON "public"."packs_automatisations" FOR INSERT TO console_equipe WITH CHECK (true);--> statement-breakpoint
REVOKE ALL ON TABLE "public"."packs_automatisations" FROM PUBLIC;--> statement-breakpoint
GRANT SELECT ON TABLE "public"."packs_automatisations" TO console_app;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "public"."packs_automatisations" TO console_equipe;--> statement-breakpoint
CREATE TRIGGER packs_automatisations_audit AFTER INSERT OR UPDATE OR DELETE ON "public"."packs_automatisations" FOR EACH ROW EXECUTE FUNCTION public.audit_ecrire_equipe();--> statement-breakpoint
ALTER TABLE "public"."connecteurs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."connecteurs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY lecture_catalogue ON "public"."connecteurs" FOR SELECT TO console_app USING (true);--> statement-breakpoint
CREATE POLICY lecture_equipe ON "public"."connecteurs" FOR SELECT TO console_equipe USING (true);--> statement-breakpoint
CREATE POLICY ajout_equipe ON "public"."connecteurs" FOR INSERT TO console_equipe WITH CHECK (true);--> statement-breakpoint
REVOKE ALL ON TABLE "public"."connecteurs" FROM PUBLIC;--> statement-breakpoint
GRANT SELECT ON TABLE "public"."connecteurs" TO console_app;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "public"."connecteurs" TO console_equipe;--> statement-breakpoint
CREATE TRIGGER connecteurs_audit AFTER INSERT OR UPDATE OR DELETE ON "public"."connecteurs" FOR EACH ROW EXECUTE FUNCTION public.audit_ecrire_equipe();--> statement-breakpoint
ALTER TABLE "public"."grilles_prix" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."grilles_prix" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY lecture_catalogue ON "public"."grilles_prix" FOR SELECT TO console_app USING (true);--> statement-breakpoint
CREATE POLICY lecture_equipe ON "public"."grilles_prix" FOR SELECT TO console_equipe USING (true);--> statement-breakpoint
CREATE POLICY ajout_equipe ON "public"."grilles_prix" FOR INSERT TO console_equipe WITH CHECK (true);--> statement-breakpoint
REVOKE ALL ON TABLE "public"."grilles_prix" FROM PUBLIC;--> statement-breakpoint
GRANT SELECT ON TABLE "public"."grilles_prix" TO console_app;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "public"."grilles_prix" TO console_equipe;--> statement-breakpoint
CREATE TRIGGER grilles_prix_audit AFTER INSERT OR UPDATE OR DELETE ON "public"."grilles_prix" FOR EACH ROW EXECUTE FUNCTION public.audit_ecrire_equipe();--> statement-breakpoint
CREATE TRIGGER metiers_sans_suppression BEFORE DELETE ON "public"."metiers" FOR EACH ROW EXECUTE FUNCTION public.catalogue_garde();--> statement-breakpoint
CREATE TRIGGER postes_sans_suppression BEFORE DELETE ON "public"."postes" FOR EACH ROW EXECUTE FUNCTION public.catalogue_garde();--> statement-breakpoint
CREATE TRIGGER automatisations_sans_suppression BEFORE DELETE ON "public"."automatisations" FOR EACH ROW EXECUTE FUNCTION public.catalogue_garde();--> statement-breakpoint
CREATE TRIGGER automatisations_code_fige BEFORE UPDATE ON "public"."automatisations" FOR EACH ROW EXECUTE FUNCTION public.catalogue_garde();--> statement-breakpoint
CREATE TRIGGER versions_automatisation_naissance BEFORE INSERT ON "public"."versions_automatisation" FOR EACH ROW EXECUTE FUNCTION public.catalogue_garde();--> statement-breakpoint
CREATE TRIGGER packs_automatisations_composition BEFORE INSERT ON "public"."packs_automatisations" FOR EACH ROW EXECUTE FUNCTION public.catalogue_garde();--> statement-breakpoint
CREATE TRIGGER versions_automatisation_immuable BEFORE UPDATE OR DELETE ON "public"."versions_automatisation" FOR EACH ROW EXECUTE FUNCTION public.catalogue_garde();--> statement-breakpoint
CREATE TRIGGER prereglages_metier_naissance BEFORE INSERT ON "public"."prereglages_metier" FOR EACH ROW EXECUTE FUNCTION public.catalogue_garde();--> statement-breakpoint
CREATE TRIGGER prereglages_metier_evolution BEFORE UPDATE ON "public"."prereglages_metier" FOR EACH ROW EXECUTE FUNCTION public.catalogue_garde();--> statement-breakpoint
-- Instances : les colonnes d'origine (C-676) nomment un autre client en cas de copie ; elles ne sont lisibles que par console_equipe. console_app peut les écrire
-- (la copie se fait par l'API) mais ne les relit jamais : le droit SELECT du rôle passe de la table entière à la liste des autres colonnes.
CREATE TRIGGER instances_coherence BEFORE INSERT OR UPDATE ON "public"."instances" FOR EACH ROW EXECUTE FUNCTION public.instances_garde();--> statement-breakpoint
REVOKE SELECT ON TABLE "public"."instances" FROM console_app;--> statement-breakpoint
GRANT SELECT ("tenant_id", "id", "organisation_id", "code_automatisation", "formule", "environnement", "etat", "cree_le", "version_courante_id", "automatisation_id") ON TABLE "public"."instances" TO console_app;--> statement-breakpoint
-- Tables de la plateforme (T2-02) : auteur obligatoire de conditions_par_defaut. La colonne naît nulle, les lignes déjà là reçoivent un auteur d'origine
-- (FORCE est levé le temps du rattrapage : le propriétaire n'a aucune politique d'écriture), puis NOT NULL.
ALTER TABLE "public"."conditions_par_defaut" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
UPDATE "public"."conditions_par_defaut" SET "auteur" = 'migration-0007' WHERE "auteur" IS NULL;--> statement-breakpoint
ALTER TABLE "public"."conditions_par_defaut" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."conditions_par_defaut" ALTER COLUMN "auteur" SET NOT NULL;--> statement-breakpoint
-- Journal d'audit des trois tables de la plateforme (ADR 0050 §6 bis levé par la fonction ci-dessus) : conditions_par_defaut porte de l'argent.
CREATE TRIGGER reglage_global_fin_de_contrat_audit AFTER INSERT OR UPDATE OR DELETE ON "public"."reglage_global_fin_de_contrat" FOR EACH ROW EXECUTE FUNCTION public.audit_ecrire_equipe();--> statement-breakpoint
CREATE TRIGGER conditions_par_defaut_audit AFTER INSERT OR UPDATE OR DELETE ON "public"."conditions_par_defaut" FOR EACH ROW EXECUTE FUNCTION public.audit_ecrire_equipe();--> statement-breakpoint
CREATE TRIGGER alertes_plateforme_audit AFTER INSERT OR UPDATE OR DELETE ON "public"."alertes_plateforme" FOR EACH ROW EXECUTE FUNCTION public.audit_ecrire_equipe();
