import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { adminPg, contexteBase, etapesBase, nomBaseDe, nomsRoles, type Admin, type ContexteBase, type PortsBase, type Sql } from "./etapes-base.js";
import { ErreurEtape, type LigneBase } from "./machine.js";

const T = randomUUID();
const ID = T.replaceAll("-", "").slice(0, 12);
const MDP = ["PREMIER", "SECOND", "TROISIEME"];
function monter(options: { grappes?: { nom: string; basesActives: number; octets: number }[]; baseExistante?: boolean } = {}) {
  const bases = new Set<string>(options.baseExistante ? [`cli_${ID}`] : []);
  const roles = new Map<string, string>();
  const coffre = new Map<string, string>();
  const ordre: string[] = [];
  const declarations: [string, number][] = [];
  let ouverte = new Set<string>();
  let n = 0;
  let panneCoffre = 0;
  const admin: Admin = {
    baseExiste: async (b) => bases.has(b),
    creerBase: async (b, modele) => { ordre.push(`creer:${b}:${modele}`); bases.add(b); },
    rolesPresents: async () => [...roles.keys()],
    poserRole: async (r, emp) => { ordre.push(`role:${r}`); roles.set(r, emp); },
    fermer: async (b) => { ordre.push(`fermer:${b}`); },
    connexionFermeeAuPublic: async () => roles.size === 3,
  };
  const ports: PortsBase = {
    grappes: async () => options.grappes ?? [{ nom: "donnees-1", basesActives: 3, octets: 10 }],
    admin: () => admin,
    coffre: {
      ranger: async (c, v) => { if (panneCoffre-- > 0) throw new Error("coffre_indisponible"); coffre.set(c, v); ordre.push(`ranger:${c}`); },
      existe: async (c) => coffre.has(c),
    },
    bouncer: () => ({ declarer: async (b, pool) => { declarations.push([b, pool]); }, recharger: async () => { ordre.push("recharger"); ouverte = new Set(declarations.map(([b]) => b)); }, repond: async (b) => ouverte.has(b) }),
    registre: { poserGrappe: async () => undefined },
    modele: "modele_v1",
    palier: async () => 2,
    motDePasse: () => MDP[n++ % 3]!,
    empreinte: (m) => `SCRAM-SHA-256$4096:sel$${m}:cle`,
  };
  const ligne = (grappe = "a_choisir"): LigneBase => ({ etat: "en_creation", etape: 0, grappe, nomBase: `cli_${T.replaceAll("-", "")}` });
  const etapes = etapesBase(ports);
  const ctx = (g?: string): ContexteBase => contexteBase(T, ligne(g), ports);
  return { ports, etapes, ctx, bases, roles, coffre, ordre, declarations, nombrePannes: (k: number) => (panneCoffre = k), ligne };
}
const etape = (m: ReturnType<typeof monter>, numero: number) => m.etapes.find((e) => e.numero === numero)!;

describe("étapes de la base du client", () => {
  it("[A-213] les étapes 1, 2, 3 et 7 sont dans l'ordre, la 4 à la 6 sont réservées à T2-35", () => {
    expect(monter().etapes.map((e) => e.numero)).toEqual([1, 2, 3, 7]);
  });

  it("[A-214] la grappe la moins chargée est choisie : nombre de bases actives, puis taille", async () => {
    const m = monter({ grappes: [{ nom: "g1", basesActives: 5, octets: 1 }, { nom: "g2", basesActives: 2, octets: 900 }, { nom: "g3", basesActives: 2, octets: 100 }] });
    const c = m.ctx();
    expect(await etape(m, 1).dejaFait(c)).toBe(false);
    await etape(m, 1).faire(c);
    expect(c.grappe).toBe("g3");
  });

  it("[A-214] aucune grappe déclarée : l'étape échoue avec un code, sans repli", async () => {
    const m = monter({ grappes: [] });
    await expect(etape(m, 1).faire(m.ctx())).rejects.toMatchObject({ code: "aucune_grappe" });
  });

  it("[A-215] la base est créée depuis modele_vN, nom issu de l'UUID seul", async () => {
    const m = monter();
    const c = m.ctx("donnees-1");
    await etape(m, 2).faire(c);
    expect(m.ordre).toEqual([`creer:cli_${ID}:modele_v1`]);
  });

  it("[A-215] @isolation une base physique cli_<id> sans ligne bases_client pour ce client fait échouer l'étape 2, sans rien brancher", async () => {
    const m = monter({ baseExistante: true });
    const c = { ...m.ctx("donnees-1"), ligne: undefined };
    expect(await etape(m, 2).dejaFait(c)).toBe(false);
    await expect(etape(m, 2).faire(c)).rejects.toMatchObject({ code: "base_orpheline" });
    expect(m.ordre).toEqual([]);
    expect(m.roles.size).toBe(0);
  });

  it("[A-215] ligne bases_client présente, base présente et rôles présents : l'étape est faite et se rejoue sans dégât", async () => {
    const m = monter();
    const c = m.ctx("donnees-1");
    await etape(m, 2).faire(c);
    await etape(m, 3).faire(c);
    const avant = m.ordre.length;
    expect(await etape(m, 2).dejaFait(c)).toBe(true);
    expect(await etape(m, 3).dejaFait(c)).toBe(true);
    expect(m.ordre.length).toBe(avant);
  });

  it("[A-216] les trois rôles sont créés et leurs mots de passe rangés dans le coffre, jamais ailleurs", async () => {
    const m = monter();
    const c = m.ctx("donnees-1");
    await etape(m, 3).faire(c);
    expect([...m.roles.keys()].sort()).toEqual(Object.values(nomsRoles(T)).sort());
    expect([...m.coffre.keys()].sort()).toEqual(["proprietaire", "app", "lecture"].map((r) => `technique/donnees/cli_${ID}/${r}`).sort());
    expect([...m.coffre.values()].sort()).toEqual([...MDP].sort());
    for (const v of m.roles.values()) expect(MDP.some((p) => v === p)).toBe(false);
    expect(m.ordre.at(-1)).toBe(`fermer:cli_${ID}`);
  });

  it("[A-216] un plantage entre le rôle et le rangement : la reprise régénère et range, aucun rôle sans secret connu", async () => {
    const m = monter();
    const c = m.ctx("donnees-1");
    m.nombrePannes(1);
    await expect(etape(m, 3).faire(c)).rejects.toBeInstanceOf(ErreurEtape);
    expect(await etape(m, 3).dejaFait(c)).toBe(false);
    await etape(m, 3).faire(c);
    expect(await etape(m, 3).dejaFait(c)).toBe(true);
    for (const [role, emp] of m.roles) expect(emp).toContain(m.coffre.get(`technique/donnees/cli_${ID}/${role.replace(`cli_${ID}_`, "")}`));
  });

  it("[A-216] @isolation un nom de client piégé ne passe pas dans le SQL", async () => {
    for (const piege of ["x'; DROP DATABASE postgres;--", `${T}"`, T.toUpperCase().slice(1), "", "a".repeat(200)]) {
      expect(() => nomBaseDe(piege)).toThrow();
      expect(() => nomsRoles(piege)).toThrow();
    }
    const requetes: string[] = [];
    const sql: Sql = { requete: async (texte, valeurs) => { requetes.push(texte); return texte.startsWith("SELECT quote_ident") ? [{ q: `"${String(valeurs?.[0])}"` }] : []; } };
    await expect(adminPg(sql).creerBase('cli_1"; DROP DATABASE postgres;--', "modele_v1")).rejects.toThrow();
    await expect(adminPg(sql).creerBase("cli_0123456789ab", "modele_v1; DROP")).rejects.toThrow();
    expect(requetes).toEqual([]);
    await adminPg(sql).creerBase("cli_0123456789ab", "modele_v1");
    expect(requetes.at(-1)).toBe('CREATE DATABASE "cli_0123456789ab" TEMPLATE "modele_v1"');
  });

  it("[A-216] aucun mot de passe dans le registre, l'erreur ni les données de la tâche", async () => {
    const m = monter();
    const c = m.ctx("donnees-1");
    m.nombrePannes(1);
    const e = await etape(m, 3).faire(c).catch((x: unknown) => x);
    expect(JSON.stringify([e, (e as Error).message, m.ligne()])).not.toMatch(/PREMIER|SECOND|TROISIEME/);
  });

  it("[A-220] la base est déclarée à PgBouncer avec le pool du palier (2 par défaut), PgBouncer est rechargé, puis la base répond", async () => {
    const m = monter();
    const c = m.ctx("donnees-1");
    expect(await etape(m, 7).dejaFait(c)).toBe(false);
    await etape(m, 7).faire(c);
    expect(m.declarations).toEqual([[`cli_${ID}`, 2]]);
    expect(m.ordre).toContain("recharger");
    expect(await etape(m, 7).dejaFait(c)).toBe(true);
  });
});
