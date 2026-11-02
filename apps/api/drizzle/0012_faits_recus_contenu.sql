ALTER TABLE "faits_recus" ADD COLUMN "payload" jsonb;--> statement-breakpoint
CREATE INDEX "faits_recus_sujet_idx" ON "faits_recus" USING btree ("tenant_id","sujet","sequence");--> statement-breakpoint
CREATE INDEX "faits_recus_non_traites_idx" ON "faits_recus" USING btree ("tenant_id","recu_le") WHERE "faits_recus"."traite_le" IS NULL;
-- T2-16b : RLS déjà activée ET forcée sur faits_recus (0006). Les droits de table (SELECT, INSERT) couvrent la nouvelle colonne ;
-- le droit UPDATE reste limité à ("traite_le", "resultat") : le contenu rangé ne se modifie jamais. Aucun DELETE ni TRUNCATE.
