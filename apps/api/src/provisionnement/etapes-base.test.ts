import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { adminPg, contexteBase, etapesBase, nomBaseDe, nomsRoles, type Admin, type ContexteBase, type PortsBase, type Sql } from "./etapes-base.js";
import { deposerProvisionnement, type FileProvisionnement } from "./declencher.js";
import { ErreurEtape, type LigneBase } from "./machine.js";

const T = randomUUID();
const ID = T.replaceAll("-", "").slice(0, 12);
const MDP = ["PREMIER", "SECOND", "TROISIEME"];
function monter(options: { grappes?: { nom: string; basesActives: number; octets: number }[]; baseExistante?: boolean } = {}) {
  const bases = new Set<string>(options.baseExistante ? [`cli_${ID}`] : []);
  const roles = new Map<string, string>();
  const marques = new Map<string, number>();
  const coffre = new Map<string, string>();
  const versions = new Map<string, number>();
  let fermee = false;
  const pannes = { fermer: 0, role: 0 };
  const ordre: string[] = [];
  const declarations: [string, number][] = [];
  let ouverte = new Set<string>();
  let n = 0;
  let panneCoffre = 0;
  const admin: Admin = {
    baseExiste: async (b) => bases.has(b),
    creerBase: async (b, modele) => { ordre.push(`creer:${b}:${modele}`); bases.add(b); },
    rolesPresents: async () => [...roles.keys()],
    poserRole: async (r, emp, version) => { if (pannes.role-- > 0) throw new Error("role_echoue"); ordre.push(`role:${r}`); roles.set(r, emp); marques.set(r, version); },
    versionSecret: async (r) => marques.get(r),
    fermer: async (b) => { ordre.push(`fermer:${b}`); if (pannes.fermer-- > 0) throw new Error("coupure entre le REVOKE et fermer_client"); fermee = true; },
    connexionFermeeAuPublic: async () => roles.size === 3,
    accesProvisionneurRetire: async () => fermee,
  };
  const ports: PortsBase = {
    grappes: async () => options.grappes ?? [{ nom: "donnees-1", basesActives: 3, octets: 10 }],
    admin: () => admin,
    coffre: {
      ranger: async (c, v) => { if (panneCoffre-- > 0) throw new Error("coffre_indisponible"); coffre.set(c, v); const n = (versions.get(c) ?? 0) + 1; versions.set(c, n); ordre.push(`ranger:${c}`); return n; },
      version: async (c) => versions.get(c),
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
  const ctx = (g?: string): ContexteBase => contexteBase(T, ligne(g));
  return { ports, etapes, ctx, bases, roles, marques, versions, pannes, coffre, ordre, declarations, nombrePannes: (k: number) => (panneCoffre = k), ligne };
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
    const sql: Sql = { requete: async (texte, valeurs) => { requetes.push(texte); return (texte.startsWith("SELECT quote_ident") ? [{ q: `"${String(valeurs?.[0])}"` }] : []) as never; } };
    const rien = (): Sql => ({ requete: async () => [] });
    await expect(adminPg(sql, rien).creerBase('cli_1"; DROP DATABASE postgres;--', "modele_v1")).rejects.toThrow();
    await expect(adminPg(sql, rien).creerBase("cli_0123456789ab", "modele_v1; DROP")).rejects.toThrow();
    expect(requetes).toEqual([]);
    await adminPg(sql, rien).creerBase("cli_0123456789ab", "modele_v1");
    expect(requetes.some((t) => t === 'CREATE DATABASE "cli_0123456789ab" TEMPLATE "modele_v1"')).toBe(true);
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

  it("[A-216] aucun mot de passe dans la charge réellement déposée dans la file", async () => {
    const m = monter();
    const c = m.ctx("donnees-1");
    await etape(m, 3).faire(c);
    const deposes: { nom: string; donnees: unknown; options: unknown }[] = [];
    const file: FileProvisionnement = { getJob: async () => undefined, add: async (nom, donnees, options) => void deposes.push({ nom, donnees, options }) };
    await deposerProvisionnement(file, T);
    expect(deposes).toHaveLength(1);
    expect(Object.keys(deposes[0]!.donnees as object)).toEqual(["tenantId"]);
    expect(JSON.stringify(deposes)).not.toMatch(/PREMIER|SECOND|TROISIEME|SCRAM/);
  });

  it("[A-216] @isolation une base fermée à moitié (coupure entre le REVOKE et fermer_client) n'est pas réputée faite ; le rejeu termine la fermeture", async () => {
    const m = monter();
    const c = m.ctx("donnees-1");
    m.pannes.fermer = 1;
    await expect(etape(m, 3).faire(c)).rejects.toBeInstanceOf(ErreurEtape);
    expect(await etape(m, 3).dejaFait(c)).toBe(false);
    await etape(m, 3).faire(c);
    expect(m.ordre.filter((o) => o.startsWith("fermer:"))).toHaveLength(2);
    expect(await etape(m, 3).dejaFait(c)).toBe(true);
  });

  it("[A-216] un secret présent mais qui ne correspond pas au rôle (plantage après le rangement, avant ALTER ROLE) est régénéré", async () => {
    const m = monter();
    const c = m.ctx("donnees-1");
    m.pannes.role = 1;
    await expect(etape(m, 3).faire(c)).rejects.toBeInstanceOf(ErreurEtape);
    expect(m.coffre.size).toBe(1);
    expect(await etape(m, 3).dejaFait(c)).toBe(false);
    await etape(m, 3).faire(c);
    expect(await etape(m, 3).dejaFait(c)).toBe(true);
    for (const [role, version] of m.marques) expect(m.versions.get(`technique/donnees/cli_${ID}/${role.replace(`cli_${ID}_`, "")}`)).toBe(version);
    m.marques.set(`cli_${ID}_app`, 99);
    expect(await etape(m, 3).dejaFait(c)).toBe(false);
  });

  it("[A-215] @isolation une ligne bases_client qui ne décrit pas CE client ne rend pas l'étape 2 faite", async () => {
    const m = monter({ baseExistante: true });
    const autre = { ...m.ligne("donnees-1"), nomBase: "cli_ffffffffffffffffffffffffffffffff" };
    const c = { ...m.ctx("donnees-1"), ligne: autre };
    expect(await etape(m, 2).dejaFait(c)).toBe(false);
    await expect(etape(m, 2).faire(c)).rejects.toMatchObject({ code: "base_orpheline" });
    const physique = { ...c, ligne: { ...autre, nomBase: `cli_${ID}` } };
    expect(await etape(m, 2).dejaFait(physique)).toBe(true);
    expect(await etape(m, 2).dejaFait({ ...c, ligne: m.ligne("donnees-1") })).toBe(true);
  });
});

// Ordre exact des ordres SQL émis par adminPg : le rôle provisionneur est NOINHERIT, il n'est plus propriétaire après ALTER DATABASE OWNER,
// donc REVOKE/GRANT ne valent que sous SET ROLE <propriétaire> (sinon simple avertissement du serveur et PUBLIC garde CONNECT).
function enregistre() {
  const journal: string[] = [];
  const faux = (marque: string, reponses: (t: string) => unknown[] = () => []): Sql => ({
    requete: async (texte, valeurs) => {
      if (texte.startsWith("SELECT quote_ident")) return [{ q: `"${String(valeurs?.[0])}"` }] as never;
      journal.push(`${marque}${texte}`);
      return reponses(texte) as never;
    },
  });
  return { journal, faux };
}
const B = `cli_${ID}`;
describe("ordre des ordres SQL de la fermeture", () => {
  it("[A-216] @isolation la base est fermée à PUBLIC dès sa création, par son propriétaire d'alors", async () => {
    const e = enregistre();
    await adminPg(e.faux(""), () => e.faux("dans:")).creerBase(B, "modele_v1");
    expect(e.journal).toEqual([`CREATE DATABASE "${B}" TEMPLATE "modele_v1"`, `REVOKE ALL ON DATABASE "${B}" FROM PUBLIC`]);
  });

  it("[A-216] @isolation fermer : SET ROLE propriétaire AVANT REVOKE/GRANT, CONNECT au provisionneur avant d'entrer dans la base, fermer_client en dernier", async () => {
    const e = enregistre();
    await adminPg(e.faux(""), () => e.faux("dans:")).fermer(B);
    const p = `"${B}_proprietaire"`;
    expect(e.journal[0]).toBe(`GRANT ${p} TO CURRENT_USER WITH SET TRUE`);
    expect(e.journal[1]).toBe(`ALTER DATABASE "${B}" OWNER TO ${p}`);
    expect(e.journal[2]).toBe(`SET ROLE ${p}; REVOKE ALL ON DATABASE "${B}" FROM PUBLIC; GRANT CONNECT ON DATABASE "${B}" TO "${B}_app", "${B}_lecture", provisionneur; RESET ROLE`);
    const dedans = e.journal[3]!;
    expect(dedans.startsWith(`dans:SET ROLE ${p}; `)).toBe(true);
    expect(dedans.endsWith("; RESET ROLE")).toBe(true);
    for (const attendu of ["ALTER SCHEMA public OWNER TO", "REVOKE ALL ON SCHEMA public FROM PUBLIC", "GRANT USAGE ON SCHEMA public TO", "GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO", "GRANT USAGE, SELECT ON SEQUENCES TO", "GRANT SELECT ON TABLES TO", "REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC"]) expect(dedans).toContain(attendu);
    expect(e.journal[4]).toBe("SELECT provisionnement.fermer_client($1)");
    expect(e.journal).toHaveLength(5);
  });

  it("[A-216] @isolation accesProvisionneurRetire contrôle pg_auth_members (3 rôles) et le droit CONNECT du provisionneur", async () => {
    const e = enregistre();
    const sql = e.faux("", () => [{ retire: false }]);
    expect(await adminPg(sql, () => sql).accesProvisionneurRetire(B)).toBe(false);
    expect(e.journal[0]).toMatch(/pg_auth_members/);
    expect(e.journal[0]).toMatch(/has_database_privilege\('provisionneur'/);
    const ok = e.faux("", () => [{ retire: true }]);
    expect(await adminPg(ok, () => ok).accesProvisionneurRetire(B)).toBe(true);
  });
});
