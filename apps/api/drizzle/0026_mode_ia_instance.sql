-- T4-54a (C-634) : mode d'IA de l'instance. ADDITIVE : aucun DROP, DELETE, TRUNCATE, RENAME ni changement de type. Numéro 0026 (après 0025, T6-01a).
-- Échec fermé : une seule transaction ; une valeur hors des deux modes ferait échouer le VALIDATE, la transaction serait annulée et rien ne serait modifié. RLS de instances inchangée (activée et forcée).
ALTER TABLE "instances" ADD COLUMN "mode_ia" text DEFAULT 'via_axion' NOT NULL;--> statement-breakpoint
ALTER TABLE "instances" ADD CONSTRAINT "instances_mode_ia_borne" CHECK ("instances"."mode_ia" IN ('client_direct', 'via_axion')) NOT VALID;--> statement-breakpoint
ALTER TABLE "instances" VALIDATE CONSTRAINT "instances_mode_ia_borne";--> statement-breakpoint
-- ===== Partie écrite à la main (drizzle-kit ne génère pas les droits) : droits par colonne de console_app sur instances (0019 a retiré les droits de table entière). =====
GRANT SELECT ("mode_ia") ON TABLE "public"."instances" TO console_app;--> statement-breakpoint
GRANT INSERT ("mode_ia") ON TABLE "public"."instances" TO console_app;--> statement-breakpoint
GRANT UPDATE ("mode_ia") ON TABLE "public"."instances" TO console_app;
-- Aucun droit pour console_lecture, console_equipe ni PUBLIC. Le changement par l'équipe seule (réauthentification, motif, journal d'audit) est un contrôle de l'API (étape suivante de T4-54), pas de la base.
-- Retour arrière (documenté, jamais exécuté par la chaîne) : REVOKE SELECT ("mode_ia"), INSERT ("mode_ia"), UPDATE ("mode_ia") ON instances FROM console_app. Rien n'est détruit.
