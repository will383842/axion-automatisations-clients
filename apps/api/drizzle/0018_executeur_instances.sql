-- T4-21 (C-017) : lien instance → cellule et état voulu de l'exécuteur. Migration ADDITIVE : aucune destruction, aucun rattrapage
-- (les lignes existantes valent NULL / false / 0). Numéro 0018 : les numéros 0014 à 0017 sont réservés à d'autres tâches.
ALTER TABLE "instances" ADD COLUMN "cellule_code" text;--> statement-breakpoint
ALTER TABLE "instances" ADD COLUMN "arret_envois" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "instances" ADD COLUMN "version_etat_voulu" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "instances" ADD CONSTRAINT "instances_cellule_fk" FOREIGN KEY ("cellule_code") REFERENCES "public"."cellules"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instances" ADD CONSTRAINT "instances_cellule_code_forme_c4" CHECK ("instances"."cellule_code" IS NULL OR ("instances"."cellule_code" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length("instances"."cellule_code") <= 64));--> statement-breakpoint
ALTER TABLE "instances" ADD CONSTRAINT "instances_version_etat_voulu_positive" CHECK ("instances"."version_etat_voulu" >= 0);--> statement-breakpoint
CREATE INDEX "instances_id_cellule_idx" ON "public"."instances" USING btree ("id","cellule_code");--> statement-breakpoint
-- La version de l'état voulu est écrite par ce déclencheur seulement : à l'INSERT elle vaut 0, à l'UPDATE +1 si l'état, l'arrêt des envois ou la cellule changent, sinon inchangée.
-- Une valeur fournie par l'application (INSERT compris) est écrasée. Sans élévation de droits (droits de l'appelant) : la fonction ne lit aucune table (OLD et NEW seulement).
CREATE FUNCTION public.instances_version_etat_voulu() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $fonction$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.version_etat_voulu := 0;
    RETURN NEW;
  END IF;
  IF NEW.etat IS DISTINCT FROM OLD.etat OR NEW.arret_envois IS DISTINCT FROM OLD.arret_envois OR NEW.cellule_code IS DISTINCT FROM OLD.cellule_code THEN
    NEW.version_etat_voulu := OLD.version_etat_voulu + 1;
  ELSE
    NEW.version_etat_voulu := OLD.version_etat_voulu;
  END IF;
  RETURN NEW;
END
$fonction$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.instances_version_etat_voulu() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER instances_etat_voulu_version BEFORE INSERT OR UPDATE ON "public"."instances" FOR EACH ROW EXECUTE FUNCTION public.instances_version_etat_voulu();--> statement-breakpoint
-- Le SELECT de console_app est par colonne depuis 0007 : les trois nouvelles colonnes sont lisibles, la table cellules ne l'est pas.
GRANT SELECT ("cellule_code", "arret_envois", "version_etat_voulu") ON TABLE "public"."instances" TO console_app;
-- Retour arrière (à la main, jamais par une migration) : DROP TRIGGER instances_etat_voulu_version ON public.instances; puis DROP FUNCTION public.instances_version_etat_voulu();
-- Les colonnes, la clé étrangère, les contraintes et l'index RESTENT (aucune destruction de données ; la garde des migrations l'interdit).
