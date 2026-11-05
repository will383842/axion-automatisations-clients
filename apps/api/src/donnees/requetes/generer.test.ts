import { describe, expect, it } from "vitest";
import { genererSql } from "./generer.js";
import { MODELE } from "./modele.js";
import { premieresRequetes } from "./premieres.js";
import { declarer, schemaParametres } from "./structure.js";

// Générateur unique du SQL (T2-37c, plan 05/11/2026) : aucune entrée textuelle libre, valeurs toujours liées, filtre d'établissement posé par le générateur.
const E1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const E2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ESTAB = '"etablissement_id" = ANY($1::uuid[])';
type Obj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const livrees = () => Object.values(premieresRequetes());
const gen = (r: ReturnType<typeof declarer>, p: Record<string, unknown> = {}, e: string[] = [E1]) => genererSql(r, schemaParametres(r).parse(p) as Record<string, unknown>, e);
const nombre = (texte: string, motif: string) => texte.split(motif).length - 1;

describe("générateur de SQL", () => {
  it("[B-173] texte exact des trois requêtes livrées", () => {
    const { compterPersonnes, listerListesProspects, etatDonnees } = premieresRequetes();
    expect(gen(compterPersonnes!)).toEqual({ texte: `SELECT count(*)::int AS "total" FROM "commun"."personnes" AS "t" WHERE "t".${ESTAB}`, valeurs: [[E1]], colonnes: ["total"] });
    expect(gen(listerListesProspects!, { limite: 5 })).toEqual({
      texte: `SELECT "t"."id" AS "id", "t"."nom" AS "nom", "t"."cree_le" AS "cree_le" FROM "commun"."listes_prospects" AS "t" WHERE "t".${ESTAB} ORDER BY "t"."cree_le" DESC, "t"."id" ASC LIMIT $2::int8`,
      valeurs: [[E1], 5], colonnes: ["id", "nom", "cree_le"],
    });
    expect(gen(listerListesProspects!).valeurs).toEqual([[E1], 50]);
    expect(gen(etatDonnees!)).toEqual({
      texte: `SELECT (SELECT count(*)::int FROM "commun"."personnes" AS "t1" WHERE "t1".${ESTAB}) AS "personnes", (SELECT coalesce(sum("t2"."taille_octets"), 0)::float8 FROM "commun"."index_fichiers" AS "t2" WHERE "t2".${ESTAB}) AS "taille_fichiers"`,
      valeurs: [[E1]], colonnes: ["personnes", "taille_fichiers"],
    });
  });

  it("[B-173] @isolation une valeur hostile ne change pas le texte : il est identique à celui d'une valeur sage", () => {
    const r = declarer({ nom: "chercher", mode: "lecture", metadonnees: false, parametres: { q: { type: "texte", max: 200 } }, forme: { type: "simple", table: "commun.personnes", sortie: { lignes: [{ colonne: "id" }] }, filtres: [{ colonne: "nom", operateur: "egal", parametre: "q" }], limite: { fixe: 10 } } });
    const sage = gen(r, { q: "Bertin" });
    for (const hostile of ["' OR true --", "E'\\\\'", "$1", "{{filtre}}", "'; DROP TABLE commun.personnes; --", "x".repeat(200), "\"; select 1 --"]) {
      const g = gen(r, { q: hostile });
      expect(g.texte).toBe(sage.texte);
      expect(g.valeurs).toEqual([[E1], hostile, 10]);
    }
    expect(schemaParametres(r).safeParse({ q: "a\u0000b" }).success).toBe(false);
    expect(schemaParametres(r).safeParse({ q: "x".repeat(10_000) }).success).toBe(false);
  });

  it("[B-173] @isolation le filtre d'établissement vient de la session, en premier conjonct, une fois par table lue, même avec des filtres déclarés", () => {
    const r = declarer({ nom: "filtree", mode: "lecture", metadonnees: false, parametres: { a: { type: "texte", max: 9 }, b: { type: "horodatage" }, c: { type: "liste_uuid", max: 3 } }, forme: { type: "simple", table: "commun.personnes", sortie: { lignes: [{ colonne: "nom" }] }, filtres: [{ colonne: "nom", operateur: "different", parametre: "a" }, { colonne: "cree_le", operateur: "inferieur_ou_egal", parametre: "b" }, { colonne: "id", operateur: "dans", parametre: "c" }, { colonne: "prenom", operateur: "est_nul" }, { colonne: "entreprise_id", operateur: "n_est_pas_nul" }], limite: { fixe: 7 } } });
    const g = gen(r, { a: "x", b: "2026-11-05T10:00:00Z", c: [E2] }, [E1, E2]);
    expect(g.texte).toBe(`SELECT "t"."nom" AS "nom" FROM "commun"."personnes" AS "t" WHERE "t".${ESTAB} AND ("t"."nom" <> $2::text) AND ("t"."cree_le" <= $3::timestamptz) AND ("t"."id" = ANY($4::uuid[])) AND ("t"."prenom" IS NULL) AND ("t"."entreprise_id" IS NOT NULL) LIMIT $5::int8`);
    expect(g.valeurs[0]).toEqual([E1, E2]);
    expect(nombre(g.texte, ESTAB)).toBe(1);
    expect(g.texte.indexOf(ESTAB)).toBeLessThan(g.texte.indexOf('"nom" <> '));
    for (const operateur of ["egal", "different", "inferieur", "inferieur_ou_egal", "superieur", "superieur_ou_egal"] as const) {
      const sym = { egal: "=", different: "<>", inferieur: "<", inferieur_ou_egal: "<=", superieur: ">", superieur_ou_egal: ">=" }[operateur];
      const o = declarer({ nom: "op", mode: "lecture", metadonnees: true, parametres: { v: { type: "entier", min: 0, max: 9 } }, forme: { type: "simple", table: "commun.index_fichiers", sortie: { agregats: [{ fonction: "compter", alias: "n" }] }, filtres: [{ colonne: "taille_octets", operateur, parametre: "v" }] } });
      expect(gen(o, { v: 3 }).texte).toContain(`AND ("t"."taille_octets" ${sym} $2::int8)`);
    }
  });

  it("[B-173] @isolation un paramètre de la requête ne remplace jamais les établissements de la session", () => {
    const r = premieresRequetes()["listerListesProspects"]!;
    const g = genererSql(r, schemaParametres(r).parse({ limite: 3, etablissements: [E2], etablissement_id: E2 }) as Record<string, unknown>, [E1]);
    expect(g.valeurs).toEqual([[E1], 3]);
    expect(JSON.stringify(g.valeurs)).not.toContain(E2);
  });

  it("[B-173] composée : chaque partie porte son propre filtre, qualifié par son propre alias, aucune corrélation", () => {
    const g = gen(premieresRequetes()["etatDonnees"]!);
    expect(nombre(g.texte, ESTAB)).toBe(2);
    expect(g.texte).toContain(`"t1".${ESTAB}`);
    expect(g.texte).toContain(`"t2".${ESTAB}`);
    expect(g.texte).not.toMatch(/"t"\./);
    expect(g.valeurs).toHaveLength(1);
  });

  it("[B-173] les numéros $n vont de 1 à N+1 : tous utilisés, aucun en double, aucun orphelin", () => {
    for (const r of livrees()) {
      const g = gen(r);
      const numeros = new Set([...g.texte.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));
      expect(numeros.size, r.nom).toBe(g.valeurs.length);
      for (let i = 1; i <= g.valeurs.length; i++) expect(numeros.has(i), `${r.nom} $${i}`).toBe(true);
    }
  });

  it("[B-173] @isolation un objet forgé après la validation est refusé par le générateur lui-même (table, colonne, valeur manquante)", () => {
    const base = premieresRequetes()["listerListesProspects"]!;
    const forge = (f: (o: Obj) => void) => { const o = structuredClone(base) as Obj; f(o); return o as typeof base; };
    const cas: [string, typeof base][] = [
      ["table", forge((o) => { o["forme"].table = "commun.personnes p, commun.exclusions"; })],
      ["table guillemets", forge((o) => { o["forme"].table = '"commun"."personnes"'; })],
      ["colonne", forge((o) => { o["forme"].sortie.lignes[0].colonne = "id; DROP TABLE x"; })],
      ["colonne chiffrée", forge((o) => { o["forme"].table = "commun.personnes"; o["forme"].sortie.lignes[0].colonne = "courriel_chiffre"; })],
      ["alias", forge((o) => { o["forme"].sortie.lignes[0].alias = 'a" FROM x --'; })],
      ["sens", forge((o) => { o["forme"].tri[0].sens = "desc; --"; })],
    ];
    for (const [nom, r] of cas) expect(() => genererSql(r, { limite: 5 }, [E1]), nom).toThrow();
    expect(() => genererSql(base, {}, [E1])).toThrow();
    expect(() => genererSql(base, { limite: 5 }, ["pas un uuid"])).toThrow();
  });

  it("[B-173] @isolation le texte généré ne contient jamais ' ; -- /* \\ ni caractère hors ASCII, ni OR, UNION, ni colonne chiffrée (livrées et formes tirées au hasard)", () => {
    let graine = 20_261_105;
    const hasard = (n: number) => { graine = (graine * 1_103_515_245 + 12_345) % 2_147_483_648; return graine % n; };
    const choisir = <T,>(l: T[]): T => l[hasard(l.length)]!;
    const textes: string[] = livrees().map((r) => gen(r).texte);
    const tables = [...MODELE.tables].filter(([, t]) => t.aEtablissement);
    for (let i = 0; i < 300; i++) {
      const [cle, t] = choisir(tables);
      const claires = [...t.colonnes].filter(([n, c]) => !c.chiffree && n !== "etablissement_id");
      const parametres: Obj = {}; const valeurs: Obj = {};
      const filtres: Obj[] = [];
      for (let k = hasard(4); k > 0; k--) {
        const [col, def] = choisir(claires);
        const nom = `p${filtres.length}`;
        const type = def.type === "uuid" ? "uuid" : def.type === "text" ? "texte" : def.type === "timestamp with time zone" ? "horodatage" : ["integer", "bigint", "smallint"].includes(def.type) ? "entier" : undefined;
        if (!type) continue;
        parametres[nom] = type === "texte" ? { type, max: 50 } : type === "entier" ? { type, min: 0, max: 99 } : { type };
        valeurs[nom] = type === "uuid" ? E2 : type === "texte" ? "x" : type === "entier" ? 5 : "2026-11-05T10:00:00Z";
        filtres.push({ colonne: col, operateur: choisir(["egal", "different", "inferieur", "superieur_ou_egal"]), parametre: nom });
      }
      const r = declarer({ nom: "hasard", mode: "lecture", metadonnees: false, parametres, forme: { type: "simple", table: cle, sortie: { lignes: Array.from({ length: 1 + hasard(4) }, (_, j) => ({ colonne: claires[j % claires.length]![0], alias: `a${j}` })) }, filtres, tri: [{ colonne: choisir(claires)[0], sens: choisir(["asc", "desc"]) }], limite: { fixe: 1 + hasard(200) } } });
      textes.push(gen(r, valeurs).texte);
    }
    expect(textes.length).toBeGreaterThan(300);
    for (const texte of textes) {
      expect(texte, texte).toMatch(/^[\x20-\x7e]+$/);
      expect(texte, texte).not.toMatch(/['\;]|--|\/\*|\bOR\b|\bUNION\b|\bor\b/);
      for (const c of MODELE.chiffrees) expect(texte, c).not.toContain(c);
    }
  });
});
