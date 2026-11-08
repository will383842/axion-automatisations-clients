import { readFileSync } from "node:fs";
import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { TABLES_COMMUNES } from "../../../../../packages/contrats/src/c5/invariants.ts";
import * as cli from "../schema-cli/index.ts";
import * as schema from "../schema.ts";
import { colonnesInterdites, tableauxSansBorne, textesSansLimite } from "./outils.ts";
import { FRAGMENTS, fusionnerFragments } from "./registre.ts";
import { COMMUNES_SOCLE, TABLES_CLI_SOCLE, TABLES_SOCLE } from "./socle.ts";

const tablesDe = (m: object) => Object.values(m).filter((v) => is(v, PgTable)) as PgTable[];
const nomsDe = (m: object) => tablesDe(m).map((t) => getTableConfig(t).name);
const frag = (nom: string, surcharge: Record<string, unknown> = {}) => ({ nom, module: { default: { fiche: nom.replace(/\.ts$/, ""), tables: ["table_a"], textes: {}, ...surcharge } } });

describe("registre des colonnes par fiche (T-REG-3)", () => {
  it("[C-034] toute table du schéma hors socle est revendiquée par exactement un fragment (console ET schema-cli)", () => {
    for (const [noms, socle, revendiquees, ou] of [
      [nomsDe(schema), TABLES_SOCLE, FRAGMENTS.tables, "console"],
      [nomsDe(cli), TABLES_CLI_SOCLE, FRAGMENTS.cli, "schema-cli"],
    ] as const) {
      for (const nom of noms.filter((n) => !socle.includes(n))) expect(revendiquees.filter((r) => r === nom), `${ou} : ${nom}`).toHaveLength(1);
      for (const nom of revendiquees) expect(noms, `${ou} : ${nom} n'existe pas`).toContain(nom);
    }
  });

  it("[C-034] chaque fragment : colonnes de texte dans sa liste fermée et bornées, aucune colonne de secret, colonnes text[] bornées", () => {
    for (const f of FRAGMENTS.fragments) {
      const tables = [...tablesDe(schema).filter((t) => f.tables.includes(getTableConfig(t).name)), ...tablesDe(cli).filter((t) => (f.cli ?? []).includes(getTableConfig(t).name))];
      expect(tables.length, f.fiche).toBe(f.tables.length + (f.cli ?? []).length);
      expect(textesSansLimite(tables, f.textes, []), f.fiche).toEqual([]);
      expect(colonnesInterdites(tables), f.fiche).toEqual([]);
      expect(tableauxSansBorne(tables), f.fiche).toEqual([]);
    }
  });

  it("[A-119] TABLES_COMMUNES égale le socle commun plus les tables communes des fragments, ni plus ni moins", () => {
    const attendu = [...COMMUNES_SOCLE, ...FRAGMENTS.communes.map((n) => `public.${n}`)].sort();
    expect([...TABLES_COMMUNES].sort()).toEqual(attendu);
  });

  it("[C-034] le socle est figé : chacune de ses tables existe et il ne grandit pas", () => {
    expect(TABLES_SOCLE).toHaveLength(105);
    expect(TABLES_CLI_SOCLE).toHaveLength(9);
    expect(COMMUNES_SOCLE).toHaveLength(32);
    for (const liste of [TABLES_SOCLE, TABLES_CLI_SOCLE, COMMUNES_SOCLE]) {
      expect(Object.isFrozen(liste)).toBe(true);
      expect(new Set(liste).size).toBe(liste.length);
      expect([...liste]).toEqual([...liste].sort());
    }
    for (const nom of TABLES_SOCLE) expect(nomsDe(schema), nom).toContain(nom);
    for (const nom of TABLES_CLI_SOCLE) expect(nomsDe(cli), nom).toContain(nom);
    for (const nom of COMMUNES_SOCLE) expect(TABLES_COMMUNES, nom).toContain(nom);
  });

  it("[C-034] la fusion refuse une table revendiquée deux fois, une table du socle, une colonne hors des tables du fragment et une borne hors de 1 à 4000", () => {
    expect(() => fusionnerFragments([frag("t9-aa.ts"), frag("t9-bb.ts")])).toThrow(/table_a.*deux fois|deux fois.*table_a/);
    expect(() => fusionnerFragments([frag("t9-aa.ts", { tables: ["table_a", "table_a"] })])).toThrow(/deux fois/);
    expect(() => fusionnerFragments([frag("t9-aa.ts", { tables: [TABLES_SOCLE[0]] })])).toThrow(/socle/);
    expect(() => fusionnerFragments([frag("t9-aa.ts", { cli: [TABLES_CLI_SOCLE[0]] })])).toThrow(/socle/);
    expect(() => fusionnerFragments([frag("t9-aa.ts", { textes: { "autre.colonne": 10 } })])).toThrow(/autre\.colonne/);
    expect(() => fusionnerFragments([frag("t9-aa.ts", { communes: ["autre"] })])).toThrow(/communes/);
    for (const borne of [0, -1, 4001, 5000, 1.5, "10", null]) expect(() => fusionnerFragments([frag("t9-aa.ts", { textes: { "table_a.col": borne } })]), String(borne)).toThrow(/borne/);
    expect(fusionnerFragments([frag("t9-aa.ts", { textes: { "table_a.col": 1 } }), frag("t9-bb.ts", { tables: ["table_b"], textes: { "table_b.col": 4000 } })]).tables).toEqual(["table_a", "table_b"]);
    for (const nom of ["T9-aa.ts", "t9-aa.test.ts", "t9-aa.d.ts", "t9.ts", "notes.md", "t9-aa.json"]) expect(() => fusionnerFragments([frag(nom)]), nom).toThrow(/nom/);
    expect(() => fusionnerFragments([{ nom: "t9-aa.ts", module: { default: { fiche: "t9-aa", tables: "table_a", textes: {} } } }])).toThrow(/forme/);
    expect(() => fusionnerFragments([frag("t9-aa.ts", { fiche: "autre" })])).toThrow(/fiche/);
    expect(fusionnerFragments([])).toMatchObject({ tables: [], cli: [], communes: [] });
  });

  it("[C-034] garde-colonnes.test.ts est figé : pas de nouveau bloc describe", () => {
    const texte = readFileSync(new URL("../garde-colonnes.test.ts", import.meta.url), "utf8");
    expect(texte.match(/^describe\(/gm)).toHaveLength(11);
    expect(texte.startsWith("// FICHIER FIGÉ")).toBe(true);
  });
});
