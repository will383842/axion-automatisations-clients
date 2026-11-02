import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DOSSIER_CLI, lireEntrees, migrerBase } from "./migrer-base.ts";
import { deroulerPlan, planifierVagues, type BaseRegistre, type PortsVagues } from "./vagues.ts";
import { sqlPg } from "../provisionnement/adaptateur-sql.js";
import { adminPg, nomBaseDe, nomsRoles } from "../provisionnement/etapes-base.js";
import { ecrireEchec, journalEchecs } from "../provisionnement/journal-echecs.js";
// Journal des échecs (CI) : le rapport JSON n'est pas publié ; la cause de chaque test rouge s'imprime ici, adresses de connexion masquées.
journalEchecs(import.meta.url);

// T2-38 : 100 bases fictives créées par CREATE DATABASE … TEMPLATE modele_v1, EN SÉRIE, avec la recette du provisionneur ; une migration additive v2 d'essai (copie du dossier, jamais le vrai) les passe toutes par les vagues.
// Connexion administrateur : comme migrer-module.int.test.ts (T2-35), adresse DIRECTE du rôle provisionneur (T232_PG_ADMIN_URL si posée) sinon calculée sur le socle par le conteneur « donnees ».
// Un .int.test.ts ne tourne que sous SOCLE_INTEGRATION=1 : une grappe introuvable FAIT ÉCHOUER l'essai, jamais un saut silencieux. Aucune donnée de client : tout vit dans le conteneur de la CI.
const docker = (...a: string[]) => {
  try { return execFileSync("docker", a, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); } catch (e) {
    ecrireEchec("docker", a[0] ?? "", (e as { stderr?: string }).stderr ?? (e as Error).message, 300);
    throw e;
  }
};
const adresseAdmin = () => {
  const id = docker("ps", "-q", "--filter", "label=com.docker.compose.project=socle", "--filter", "label=com.docker.compose.service=donnees");
  if (!id) throw new Error("conteneur donnees introuvable : le socle doit tourner (ops/socle/lancer.sh, fragment d'essai)");
  const mdp = docker("exec", id, "sh", "-c", 'printf %s/provisionneur "$SOCLE_PG_MOT_DE_PASSE" | sha256sum | cut -c1-64');
  return `postgresql://provisionneur:${mdp}@localhost/postgres?host=%2Ftmp%2Fsocle-donnees-socket`;
};
const ADMIN = process.env["T232_PG_ADMIN_URL"] ?? adresseAdmin();
const vers = (base: string) => { const u = new URL(ADMIN); u.pathname = `/${base}`; return u.toString(); };
// Une seule connexion par base à la fois : 100 bases créées en série ne doivent pas laisser 100+ pools ouverts (53300 « remaining connection slots » sur migrer-module.int.test.ts, joué ensuite).
const pools = new Map<string, pg.Pool>();
const pool = (base: string) => {
  let p = pools.get(base);
  if (!p) { p = new pg.Pool({ connectionString: vers(base), max: 1 }); p.on("error", () => undefined); pools.set(base, p); }
  return p;
};
const fermerPool = async (base: string) => { const p = pools.get(base); pools.delete(base); await p?.end().catch(() => undefined); };
afterAll(async () => { await Promise.all([...pools.keys()].map(fermerPool)); });
const empreinteVide = () => `SCRAM-SHA-256$4096:${randomBytes(16).toString("base64")}$${randomBytes(32).toString("base64")}:${randomBytes(32).toString("base64")}`;

// Une base fictive comme la recette la crée (étapes 2, 3, 6), pas encore fermée : le provisionneur y reste membre du propriétaire.
async function creerBaseFictive(i: number): Promise<BaseRegistre> {
  const id = randomUUID();
  const base = nomBaseDe(id);
  const admin = adminPg(sqlPg(pool("postgres")), (b) => sqlPg(pool(b)));
  await admin.creerBase(base, "modele_v1");
  let v = 0;
  for (const r of Object.values(nomsRoles(id))) await admin.poserRole(r, empreinteVide(), ++v);
  const p = nomsRoles(id).proprietaire;
  await pool(base).query(`GRANT ${p} TO CURRENT_USER WITH SET TRUE`);
  // Comme migrer-module.int.test.ts : le propriétaire possède la base (il y crée donc les schémas commun et trace), PUBLIC n'a pas CONNECT, le provisionneur le garde.
  await pool("postgres").query(`ALTER DATABASE ${base} OWNER TO ${p}; SET ROLE ${p}; REVOKE ALL ON DATABASE ${base} FROM PUBLIC; GRANT CONNECT ON DATABASE ${base} TO provisionneur; RESET ROLE`);
  await fermerPool(base);
  await migrerBase(base, lireEntrees(DOSSIER_CLI).length, { url: vers(base) });
  return { id: `id${i}`, tenantId: id, nomBase: base, versionStructure: lireEntrees(DOSSIER_CLI).length, etat: "active" };
}

describe("vagues sur des bases fictives (grappe jetable)", () => { // fiche: T2-38
  let dossierV2 = "";
  let cible = 0;
  const registre: BaseRegistre[] = [];
  const mondeDe = (liste: BaseRegistre[], alertes: { clientId: string }[], notes: string[]): PortsVagues => ({
    async bases() { return liste.map((b) => ({ ...b })); },
    async graine() { return undefined; },
    async enregistrerGraine() {},
    tirerGraine: () => 476,
    async migrer(nomBase, version) { await migrerBase(nomBase, version, { url: vers(nomBase), dossier: dossierV2 }); },
    async noter(baseId, version, resultat) { notes.push(resultat); if (resultat === "ok") liste.find((b) => b.id === baseId)!.versionStructure = version; },
    async alerter(a) { alertes.push(a); },
  });
  const versionDe = async (base: string) => { const c = new pg.Client({ connectionString: vers(base) }); await c.connect(); try { return (await c.query("SELECT max(version)::int AS v FROM public.version_structure")).rows[0]?.v as number; } finally { await c.end(); } };
  beforeAll(async () => {
    dossierV2 = mkdtempSync(join(tmpdir(), "cli-v2-"));
    cpSync(DOSSIER_CLI, dossierV2, { recursive: true });
    const journal = JSON.parse(readFileSync(join(dossierV2, "meta/_journal.json"), "utf8"));
    cible = journal.entries.length + 1;
    journal.entries.push({ idx: journal.entries.length, version: "7", when: journal.entries.at(-1).when + 1000, tag: "9999_essai_vagues", breakpoints: true });
    writeFileSync(join(dossierV2, "meta/_journal.json"), JSON.stringify(journal));
    writeFileSync(join(dossierV2, "9999_essai_vagues.sql"), 'ALTER TABLE "commun"."etablissements" ADD COLUMN "note_vagues" text;');
    try {
      for (let i = 0; i < 100; i++) registre.push(await creerBaseFictive(i));
    } catch (e) {
      // Sans cette ligne, un beforeAll en erreur donnait « 0 verts, 0 rouges » sans cause dans le journal.
      ecrireEchec("vagues.int.test.ts", `beforeAll base ${registre.length}`, (e as Error).message);
      throw e;
    }
  }, 900_000);

  it("la grappe jetable répond (échec, pas saut)", async () => {
    expect((await pool("postgres").query("SELECT current_user AS u")).rows[0]?.u).toBe("provisionneur");
  }, 30_000);

  it("[C-476] une migration canari réussit sur 100 bases", async () => {
    const alertes: { clientId: string }[] = [];
    const notes: string[] = [];
    const ports = mondeDe(registre, alertes, notes);
    const noms = registre.map((b) => b.nomBase);
    const plan = await planifierVagues(cible, { recette: [noms[0]!], internes: [noms[1]!, noms[2]!] }, ports);
    expect(plan.vagues.find((v) => v.nom === "canari")?.bases).toHaveLength(5);
    const r = await deroulerPlan(plan, ports);
    expect(r.arretee).toBe(false);
    expect(r.vagues.flatMap((v) => v.echecs)).toEqual([]);
    expect(alertes).toEqual([]);
    expect(notes.filter((x) => x === "ok")).toHaveLength(100);
    // Relu dans les bases elles-mêmes, pas seulement dans le registre.
    for (const base of [noms[0]!, noms[50]!, noms[99]!]) {
      expect(await versionDe(base)).toBe(cible);
      expect((await pool(base).query("SELECT 1 FROM information_schema.columns WHERE table_name = 'etablissements' AND column_name = 'note_vagues'")).rowCount).toBe(1);
    }
  }, 900_000);

  it("[A-228] sur de vraies bases, un échec reste isolé : la base en échec reste en version précédente, alerte, les autres migrent", async () => {
    const trois = [await creerBaseFictive(1000), await creerBaseFictive(1001), await creerBaseFictive(1002)];
    // La colonne existe déjà dans la deuxième : sa migration additive échoue (et se défait), les deux autres passent.
    const p = pool(trois[1]!.nomBase);
    await p.query(`SET ROLE ${nomsRoles(trois[1]!.tenantId).proprietaire}`);
    await p.query('ALTER TABLE "commun"."etablissements" ADD COLUMN "note_vagues" text');
    await p.query("RESET ROLE");
    const alertes: { clientId: string }[] = [];
    const notes: string[] = [];
    const ports = mondeDe(trois, alertes, notes);
    const plan = await planifierVagues(cible, { recette: [], internes: [] }, ports);
    const r = await deroulerPlan(plan, ports);
    expect(r.vagues.flatMap((v) => v.echecs)).toEqual([trois[1]!.nomBase]);
    expect(r.vagues.flatMap((v) => v.reussies).sort()).toEqual([trois[0]!.nomBase, trois[2]!.nomBase].sort());
    expect(alertes).toEqual([{ type: "migration_echec", clientId: trois[1]!.tenantId }]);
    expect(notes.filter((x) => x === "quarantaine")).toHaveLength(1);
    expect(trois[1]!.versionStructure).toBe(cible - 1);
    expect(await versionDe(trois[1]!.nomBase)).toBe(cible - 1);
    expect(await versionDe(trois[0]!.nomBase)).toBe(cible);
    expect(await versionDe(trois[2]!.nomBase)).toBe(cible);
  }, 300_000);

  it("[A-232] en production, migrerBase refuse une cible plus basse sur une base réelle déjà migrée", async () => {
    const avant = process.env["NODE_ENV"];
    try {
      process.env["NODE_ENV"] = "production";
      await expect(migrerBase(registre[3]!.nomBase, cible - 1, { url: vers(registre[3]!.nomBase), dossier: dossierV2 })).rejects.toThrow(/descendante/);
    } finally {
      if (avant === undefined) delete process.env["NODE_ENV"]; else process.env["NODE_ENV"] = avant;
    }
  }, 60_000);
});
