import { bigint, index, inet, jsonb, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

// Journal d'audit chaîné (C5, invariant 4). Table en AJOUT SEUL : aucune écriture directe, tout passe par public.audit_ajouter
// (migration 0001, fonctions relues en 2 tours). Droits, RLS, FORCE et déclencheurs sont écrits à la main dans cette migration :
// drizzle-kit ne les génère pas.
export const actionAudit = pgEnum("action_audit", [
  "insertion",
  "modification",
  "suppression",
  "blocage_cle",
  "levee_blocage_cle",
  "levee_blocage_cle_echouee",
  "levee_budget_jour",
]);

// tenant_id facultatif : seule table dans ce cas (TENANT_FACULTATIF de C5), pour les actions de l'équipe sans client.
// Aucune clé étrangère : une ligne d'audit survit à l'objet qu'elle décrit.
export const journalAudit = pgTable(
  "journal_audit",
  {
    id: bigint("id", { mode: "bigint" }).primaryKey().generatedAlwaysAsIdentity(),
    tenantId: uuid("tenant_id"),
    acteur: text("acteur").notNull(),
    action: actionAudit("action").notNull(),
    entite: text("entite").notNull(),
    entiteId: text("entite_id"),
    ancienne: jsonb("ancienne"),
    nouvelle: jsonb("nouvelle"),
    ip: inet("ip"),
    creeLe: timestamp("cree_le", { withTimezone: true }).notNull().defaultNow(),
    empreintePrecedente: text("empreinte_precedente"),
    empreinte: text("empreinte").notNull(),
  },
  (t) => [index("journal_audit_tenant_id_idx").on(t.tenantId, t.id)],
);
