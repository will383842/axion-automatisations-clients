import { sql } from "drizzle-orm";
import { check, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

// public.version_structure : une ligne par migration appliquée à CETTE base (A-225). Écrite par migrerBase, propriété du rôle propriétaire.
export const versionStructure = pgTable(
  "version_structure",
  {
    version: integer("version").primaryKey(),
    appliqueeLe: timestamp("appliquee_le", { withTimezone: true }).notNull().defaultNow(),
    empreinte: text("empreinte").notNull(),
  },
  (t) => [check("version_structure_version", sql`${t.version} >= 1`)],
);
