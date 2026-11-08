-- T5-22a (ADR 0141) : ouvre l'écriture de rapports_mensuels à console_app (décision laissée ouverte par l'ADR 0116). DROITS SEULEMENT : aucune table, colonne, fonction ni valeur d'énumération ; aucun DROP, DELETE, TRUNCATE, RENAME ni ALTER POLICY.
-- Isolation entre clients : la politique permissive isolation_client (0022) reste ; les deux politiques ci-dessous sont RESTRICTIVES et ne peuvent que retirer des droits.
-- Retour arrière (documenté, jamais exécuté par la chaîne) : REVOKE des deux droits et DROP POLICY des deux politiques, par une migration de contraction décidée par l'architecte.
GRANT INSERT ("tenant_id", "id", "organisation_id", "mois", "objet_pdf_ref") ON TABLE "public"."rapports_mensuels" TO console_app;--> statement-breakpoint
GRANT UPDATE ("etat", "envoye_par", "envoye_le") ON TABLE "public"."rapports_mensuels" TO console_app;--> statement-breakpoint
CREATE POLICY acteur_obligatoire_insert ON "public"."rapports_mensuels" AS RESTRICTIVE FOR INSERT TO console_app WITH CHECK (NULLIF(current_setting('app.acteur', true), '') IS NOT NULL AND etat = 'prepare' AND envoye_par IS NULL);--> statement-breakpoint
CREATE POLICY envoi_une_seule_fois ON "public"."rapports_mensuels" AS RESTRICTIVE FOR UPDATE TO console_app USING (etat = 'prepare') WITH CHECK (etat = 'envoye' AND envoye_par = NULLIF(current_setting('app.acteur', true), '') AND envoye_le = now());
