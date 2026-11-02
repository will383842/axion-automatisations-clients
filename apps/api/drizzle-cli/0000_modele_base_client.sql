CREATE SCHEMA "commun";
--> statement-breakpoint
CREATE SCHEMA "trace";
--> statement-breakpoint
CREATE TABLE "commun"."entreprises" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"raison_sociale" text NOT NULL,
	"siren" text,
	"cree_le" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entreprises_raison_longueur" CHECK (char_length("raison_sociale") <= 500),
	CONSTRAINT "entreprises_siren_forme" CHECK ("commun"."entreprises"."siren" IS NULL OR "commun"."entreprises"."siren" ~ '^[0-9]{9}$')
);
--> statement-breakpoint
CREATE TABLE "commun"."etablissements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"nom" text NOT NULL,
	"cree_le" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "etablissements_nom_longueur" CHECK (char_length("nom") <= 500)
);
--> statement-breakpoint
CREATE TABLE "commun"."exclusions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"genre" text NOT NULL,
	"empreinte" "bytea" NOT NULL,
	"cree_le" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "exclusions_genre_empreinte_unique" UNIQUE("genre","empreinte"),
	CONSTRAINT "exclusions_genre" CHECK ("commun"."exclusions"."genre" IN ('courriel', 'telephone')),
	CONSTRAINT "exclusions_empreinte_taille" CHECK (octet_length("empreinte") = 32)
);
--> statement-breakpoint
CREATE TABLE "commun"."index_fichiers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"etablissement_id" uuid NOT NULL,
	"cle_objet" text NOT NULL,
	"empreinte" text NOT NULL,
	"taille_octets" bigint NOT NULL,
	"type_contenu" text NOT NULL,
	"cree_le" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "index_fichiers_cle_unique" UNIQUE("etablissement_id","cle_objet"),
	CONSTRAINT "index_fichiers_taille" CHECK ("commun"."index_fichiers"."taille_octets" BETWEEN 0 AND 9007199254740991),
	CONSTRAINT "index_fichiers_cle_longueur" CHECK (char_length("cle_objet") <= 500),
	CONSTRAINT "index_fichiers_type_longueur" CHECK (char_length("type_contenu") <= 500),
	CONSTRAINT "index_fichiers_empreinte_forme" CHECK ("commun"."index_fichiers"."empreinte" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "commun"."listes_prospects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"etablissement_id" uuid NOT NULL,
	"nom" text NOT NULL,
	"cree_le" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "listes_prospects_nom_longueur" CHECK (char_length("nom") <= 500)
);
--> statement-breakpoint
CREATE TABLE "commun"."listes_prospects_personnes" (
	"liste_id" uuid NOT NULL,
	"personne_id" uuid NOT NULL,
	"retire_le" timestamp with time zone,
	CONSTRAINT "listes_prospects_personnes_liste_id_personne_id_pk" PRIMARY KEY("liste_id","personne_id")
);
--> statement-breakpoint
CREATE TABLE "commun"."personnes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"etablissement_id" uuid NOT NULL,
	"entreprise_id" uuid,
	"nom" text NOT NULL,
	"prenom" text,
	"courriel_chiffre" "bytea",
	"courriel_empreinte" "bytea",
	"telephone_chiffre" "bytea",
	"telephone_empreinte" "bytea",
	"cree_le" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "personnes_nom_longueur" CHECK (char_length("nom") <= 500),
	CONSTRAINT "personnes_prenom_longueur" CHECK (char_length("prenom") <= 500),
	CONSTRAINT "personnes_courriel_empreinte_taille" CHECK ("courriel_empreinte" IS NULL OR octet_length("courriel_empreinte") = 32),
	CONSTRAINT "personnes_telephone_empreinte_taille" CHECK ("telephone_empreinte" IS NULL OR octet_length("telephone_empreinte") = 32)
);
--> statement-breakpoint
CREATE TABLE "version_structure" (
	"version" integer PRIMARY KEY NOT NULL,
	"appliquee_le" timestamp with time zone DEFAULT now() NOT NULL,
	"empreinte" text NOT NULL,
	CONSTRAINT "version_structure_version" CHECK ("version_structure"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "trace"."evenements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"qui" text NOT NULL,
	"quoi" text NOT NULL,
	"objet" text NOT NULL,
	"quand" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "evenements_quoi" CHECK ("trace"."evenements"."quoi" IN ('import', 'modification', 'export')),
	CONSTRAINT "evenements_longueur" CHECK (char_length("trace"."evenements"."qui") <= 200 AND char_length("trace"."evenements"."objet") <= 500)
);
--> statement-breakpoint
ALTER TABLE "commun"."index_fichiers" ADD CONSTRAINT "index_fichiers_etablissement_fk" FOREIGN KEY ("etablissement_id") REFERENCES "commun"."etablissements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commun"."listes_prospects" ADD CONSTRAINT "listes_prospects_etablissement_fk" FOREIGN KEY ("etablissement_id") REFERENCES "commun"."etablissements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commun"."listes_prospects_personnes" ADD CONSTRAINT "lpp_liste_fk" FOREIGN KEY ("liste_id") REFERENCES "commun"."listes_prospects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commun"."listes_prospects_personnes" ADD CONSTRAINT "lpp_personne_fk" FOREIGN KEY ("personne_id") REFERENCES "commun"."personnes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commun"."personnes" ADD CONSTRAINT "personnes_etablissement_fk" FOREIGN KEY ("etablissement_id") REFERENCES "commun"."etablissements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commun"."personnes" ADD CONSTRAINT "personnes_entreprise_fk" FOREIGN KEY ("entreprise_id") REFERENCES "commun"."entreprises"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "personnes_courriel_empreinte_idx" ON "commun"."personnes" USING btree ("etablissement_id","courriel_empreinte");--> statement-breakpoint
CREATE INDEX "personnes_telephone_empreinte_idx" ON "commun"."personnes" USING btree ("etablissement_id","telephone_empreinte");--> statement-breakpoint
CREATE INDEX "evenements_quand_idx" ON "trace"."evenements" USING btree ("quand");
--> statement-breakpoint
CREATE FUNCTION trace.evenements_refuser()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $fonction$
BEGIN
  RAISE EXCEPTION 'trace.evenements : ajout seul, aucune modification, suppression ni vidage' USING ERRCODE = 'insufficient_privilege';
END
$fonction$;--> statement-breakpoint
REVOKE ALL ON FUNCTION trace.evenements_refuser() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER evenements_refuser_ligne BEFORE UPDATE OR DELETE ON "trace"."evenements" FOR EACH ROW EXECUTE FUNCTION trace.evenements_refuser();--> statement-breakpoint
CREATE TRIGGER evenements_refuser_vidage BEFORE TRUNCATE ON "trace"."evenements" FOR EACH STATEMENT EXECUTE FUNCTION trace.evenements_refuser();
