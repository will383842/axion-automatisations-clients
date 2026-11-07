import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TABLES_V0_C5 } from "./tables-c5.ts";

// T2-21, porte du lot 2 : preuve STATIQUE que les migrations de la console créent chaque table de la version 0 de C5.
// La preuve sur la base migrée (int) reste à écrire : dette T2-21-suite (voir la PR).
const dossier = fileURLToPath(new URL("../../apps/api/drizzle/", import.meta.url));
const creees = () => {
  const noms = new Set<string>();
  for (const f of readdirSync(dossier).filter((n) => n.endsWith(".sql"))) {
    for (const m of readFileSync(dossier + f, "utf8").matchAll(/CREATE TABLE (?:IF NOT EXISTS )?(?:"[a-z_]+"\.)?"([a-z_]+)"/gi)) noms.add(m[1] as string);
  }
  return noms;
};

describe("porte du lot 2 : tables de la version 0 de C5", () => {
  it("[C-400] toutes les tables de la version 0 de C5 existent dans les migrations de la console, dont formule par automatisation, plan commercial et phases, métier, outils du client et préréglages", () => {
    const noms = creees();
    const manquantes = Object.entries(TABLES_V0_C5).filter(([, t]) => !noms.has(t)).map(([libelle]) => libelle);
    expect(manquantes).toEqual([]);
  });
});
