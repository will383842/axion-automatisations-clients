import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PLATEFORME_ID } from "../db/schema/aides.js";
import { creerDepotRechercheSql } from "./depot-sql.js";
import { rechercher, SOURCES } from "./index.js";

// Dépôt SQL de la recherche (T3-09a), sans Docker : un faux client enregistre le texte et les paramètres de chaque requête. Les essais réels sont dans clients.int.test.ts.
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const secondA = { role: "second_administrateur", portee: { clients: [A], automatisations: [] as string[] } };
const dirigeant = { role: "dirigeant", portee: { clients: [] as string[], automatisations: [] as string[] } };

function fauxPool() {
  const requetes: { texte: string; params: unknown[] }[] = [];
  const connexions: string[] = [];
  const client = { query: async (texte: string, params: unknown[] = []) => { requetes.push({ texte, params }); return { rows: [] }; }, release: () => undefined };
  const pool = { connect: async () => { connexions.push("connect"); return client; } };
  return { pool: pool as never, requetes, connexions };
}
const lectures = (r: { texte: string }[]) => r.filter((q) => /\bFROM\b/i.test(q.texte));
const racine = new URL("../", import.meta.url);

describe("dépôt SQL de la recherche", () => {
  it("[B-070] @isolation la recherche ne lit aucune base client", async () => {
    const fichiers = [...readdirSync(fileURLToPath(new URL("recherche/", racine))).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts")).map((f) => `recherche/${f}`), "routes/recherche.ts"];
    expect(fichiers).toContain("recherche/depot-sql.ts");
    for (const f of fichiers) {
      const texte = readFileSync(new URL(f, racine), "utf8");
      expect(texte, f).not.toMatch(/from\s+["'][^"']*(donnees\/|courtier\/|bases-client|vue-client)/);
      expect(texte, f).not.toMatch(/avecClient\b/);
    }
    const { pool, requetes, connexions } = fauxPool();
    await rechercher(creerDepotRechercheSql(pool), dirigeant, "bertin", 5);
    expect(connexions).toEqual(["connect"]);
    expect(requetes[0]?.texte).toBe("BEGIN READ ONLY");
    expect(requetes.at(-1)?.texte).toBe("COMMIT");
    const tables = new Set(lectures(requetes).flatMap((q) => [...q.texte.matchAll(/\b(?:FROM|JOIN)\s+([a-z_.]+)/gi)].map((m) => m[1]?.replace(/^public\./, ""))));
    expect([...tables].sort()).toEqual(["automatisations", "contacts", "demandes", "factures", "instances", "organisations"]);
  });

  it("[LOT3-recherche] chaque requête porte le filtre de portée et l'exclusion de la plateforme en paramètres liés", async () => {
    const { pool, requetes } = fauxPool();
    await rechercher(creerDepotRechercheSql(pool), secondA, "bertin", 5);
    const l = lectures(requetes);
    expect(l).toHaveLength(SOURCES.length);
    for (const q of l) {
      expect(q.texte).toMatch(/\bo\.id\s*<>\s*\$\d/);
      expect(q.texte).toMatch(/\$\d+::boolean\s+OR\s+\w+\.tenant_id\s*=\s*ANY\(\$\d+::uuid\[\]\)/);
      expect(q.texte).toMatch(/ESCAPE/);
      expect(q.texte).toMatch(/LIMIT\s+\$\d/);
      expect(q.params).toContain(PLATEFORME_ID);
      expect(q.params).toContain(false);
      expect(q.params).toContainEqual([A]);
      expect(q.params).toContain(5);
      expect(q.texte).not.toContain(A);
      expect(q.texte).not.toContain(PLATEFORME_ID);
    }
    const { pool: p2, requetes: r2 } = fauxPool();
    await rechercher(creerDepotRechercheSql(p2), { role: "second_administrateur", portee: { clients: ["*"], automatisations: [] } }, "bertin", 5);
    for (const q of lectures(r2)) { expect(q.params).toContain(true); expect(q.params).toContainEqual([]); expect(JSON.stringify(q.params)).not.toContain("*"); }
  });

  it("[LOT3-recherche] aucune requête ne lit reference_texte ni une colonne de montant", async () => {
    const { pool, requetes } = fauxPool();
    await rechercher(creerDepotRechercheSql(pool), dirigeant, "bertin", 5);
    for (const q of lectures(requetes)) expect(q.texte).not.toMatch(/reference_texte|montant|_centimes|\btva\b|\bttc\b|\*/i);
  });

  it("[LOT3-recherche] le texte SQL ne dépend pas du terme cherché", async () => {
    const un = fauxPool();
    const deux = fauxPool();
    await rechercher(creerDepotRechercheSql(un.pool), secondA, "bertin", 5);
    await rechercher(creerDepotRechercheSql(deux.pool), secondA, "'; DROP TABLE x; -- 33333333-3333-4333-8333-333333333333", 5);
    expect(lectures(un.requetes).map((q) => q.texte)).toEqual(lectures(deux.requetes).map((q) => q.texte));
    expect(lectures(un.requetes).map((q) => q.params)).not.toEqual(lectures(deux.requetes).map((q) => q.params));
  });

  it("[LOT3-recherche] le nombre de requêtes ne dépend pas des clients hors portée", async () => {
    const nombres: number[] = [];
    for (const membre of [dirigeant, secondA, { role: "second_administrateur", portee: { clients: [A, B], automatisations: [] as string[] } }]) {
      const { pool, requetes } = fauxPool();
      await rechercher(creerDepotRechercheSql(pool), membre, "bertin", 5);
      nombres.push(lectures(requetes).length);
    }
    expect(nombres).toEqual([5, 5, 5]);
  });
});
