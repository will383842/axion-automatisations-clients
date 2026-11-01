import { getTableConfig, integer, pgTable, text, uuid, type PgTable } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import * as schema from "./schema.ts";

// Garde « aucun secret en base » (T2-06) : aucune colonne du schéma ne porte un nom de secret. Un secret vit dans le coffre ; la base ne garde qu'une référence.
const INTERDITS = ["secret", "mot_de_passe", "password", "token", "jeton", "cle_api"];
// Liste fermée des colonnes de référence permises : chaque ajout se relit en 2 tours (zone sécurité).
const PERMISES: readonly string[] = ["reference_coffre"];

export function colonnesInterdites(tables: PgTable[]): string[] {
  return tables.flatMap((t) => {
    const { name, columns } = getTableConfig(t);
    return columns.filter((c) => INTERDITS.some((m) => c.name.toLowerCase().includes(m)) && !PERMISES.includes(c.name)).map((c) => `${name}.${c.name}`);
  });
}
const tablesDuSchema = () => Object.values(schema).filter((v): v is PgTable => typeof v === "object" && v !== null && Symbol.for("drizzle:IsDrizzleTable") in v);

describe("garde des colonnes : aucun secret en base", () => {
  it("[LOT2-garde] aucune colonne du schéma réel n'est nommée comme un secret", () => {
    expect(tablesDuSchema().length).toBeGreaterThan(10);
    expect(colonnesInterdites(tablesDuSchema())).toEqual([]);
  });

  it("[LOT2-garde] la garde des colonnes refuse une colonne nommée comme un secret", () => {
    for (const nom of ["jeton_acces", "mot_de_passe_hash", "secret_client", "api_token", "cle_api_x", "Password"]) {
      const t = pgTable("essai_garde", { id: uuid("id"), [nom]: text(nom) });
      expect(colonnesInterdites([t]), nom).toEqual([`essai_garde.${nom}`]);
    }
    expect(colonnesInterdites([pgTable("essai_garde", { id: uuid("id"), reference_coffre: text("reference_coffre"), unites_ia: integer("unites_ia") })])).toEqual([]);
  });

  it("[LOT2-garde] la liste des colonnes permises est fermée : une seule référence au coffre", () => {
    expect(PERMISES).toEqual(["reference_coffre"]);
  });
});
