import { sql } from "drizzle-orm";
import { check, index, pgSchema, text, timestamp, uuid } from "drizzle-orm/pg-core";

// Schéma `trace` : qui a importé, modifié ou exporté quoi. Ajout seul : un déclencheur (écrit dans la migration) refuse UPDATE, DELETE et TRUNCATE.
export const trace = pgSchema("trace");
export const evenements = trace.table(
  "evenements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    qui: text("qui").notNull(),
    quoi: text("quoi").notNull(),
    objet: text("objet").notNull(),
    quand: timestamp("quand", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("evenements_quoi", sql`${t.quoi} IN ('import', 'modification', 'export')`),
    check("evenements_longueur", sql`char_length(${t.qui}) <= 200 AND char_length(${t.objet}) <= 500`),
    index("evenements_quand_idx").on(t.quand),
  ],
);
