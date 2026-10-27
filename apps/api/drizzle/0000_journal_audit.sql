CREATE TYPE "public"."action_audit" AS ENUM('insertion', 'modification', 'suppression', 'blocage_cle', 'levee_blocage_cle', 'levee_blocage_cle_echouee', 'levee_budget_jour');--> statement-breakpoint
CREATE TABLE "journal_audit" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "journal_audit_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" uuid,
	"acteur" text NOT NULL,
	"action" "action_audit" NOT NULL,
	"entite" text NOT NULL,
	"entite_id" text,
	"ancienne" jsonb,
	"nouvelle" jsonb,
	"ip" "inet",
	"cree_le" timestamp with time zone DEFAULT now() NOT NULL,
	"empreinte_precedente" text,
	"empreinte" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX "journal_audit_tenant_id_idx" ON "journal_audit" USING btree ("tenant_id","id");