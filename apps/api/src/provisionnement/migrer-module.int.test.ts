import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { migrerBase, roleMigrationModule } from "../donnees/migrer-base.js";
import { sqlPg } from "./adaptateur-sql.js";
import { adminPg, nomBaseDe, nomsRoles } from "./etapes-base.js";

// Étape 6 sur une grappe jetable (T235_PG_ADMIN_URL : adresse DIRECTE du rôle provisionneur, init.sql joué). La base est créée par la vraie recette (adminPg) mais
// n'est PAS fermée : la fermeture retire au provisionneur le droit de prendre le rôle propriétaire (dette : T2-38 fixe qui lance les migrations après la fermeture).
const ADMIN = process.env["T235_PG_ADMIN_URL"];
const ESSAI = fileURLToPath(new URL("../../../../tests/modules/essai/migrations", import.meta.url));
const vers = (base: string) => { const u = new URL(ADMIN ?? "postgres://x@localhost/postgres"); u.pathname = `/${base}`; return u.toString(); };
const pools: pg.Pool[] = [];
const pool = (base: string) => { const p = new pg.Pool({ connectionString: vers(base), max: 1 }); pools.push(p); return p; };
afterAll(async () => { await Promise.all(pools.map((p) => p.end().catch(() => undefined))); });
const empreinteVide = `SCRAM-SHA-256$4096:${randomBytes(16).toString("base64")}$${randomBytes(32).toString("base64")}:${randomBytes(32).toString("base64")}`;

async function clientNonFerme() {
  const id = randomUUID();
  const base = nomBaseDe(id);
  const admin = adminPg(sqlPg(pool("postgres")), (b) => sqlPg(pool(b)));
  await admin.creerBase(base, "modele_v1");
  let v = 0;
  for (const r of Object.values(nomsRoles(id))) await admin.poserRole(r, empreinteVide, ++v);
  const dans = pool(base);
  await dans.query(`GRANT ${nomsRoles(id).proprietaire} TO CURRENT_USER WITH SET TRUE`);
  // Comme après la fermeture : le propriétaire possède la base (il y crée donc le schéma du module).
  const p = nomsRoles(id).proprietaire;
  await pool("postgres").query(`ALTER DATABASE ${base} OWNER TO ${p}; SET ROLE ${p}; GRANT CONNECT ON DATABASE ${base} TO provisionneur; RESET ROLE`);
  await dans.query(`SET ROLE ${p}`);
  return { id, base, dans, roles: nomsRoles(id) };
}
// Lit comme un rôle donné (le rôle de migration du module possède les tables du module ; le provisionneur ne le garde pas après la migration).
async function comme(c: { dans: pg.Pool }, role: string, sql: string, valeurs: unknown[] = []) {
  await c.dans.query("RESET ROLE");
  await c.dans.query(`GRANT ${role} TO CURRENT_USER WITH SET TRUE`).catch(() => undefined);
  await c.dans.query(`SET ROLE ${role}`);
  try { return (await c.dans.query(sql, valeurs)).rows; } finally { await c.dans.query("RESET ROLE"); }
}
const dossierAvec = (sql: string) => {
  const d = mkdtempSync(join(tmpdir(), "mod-"));
  mkdirSync(`${d}/meta`);
  writeFileSync(`${d}/0000_x.sql`, sql);
  writeFileSync(`${d}/meta/_journal.json`, JSON.stringify({ version: "7", dialect: "postgresql", entries: [{ idx: 0, version: "7", when: 1793612974019, tag: "0000_x", breakpoints: true }] }));
  return d;
};

// Un .int.test.ts ne tourne que sous SOCLE_INTEGRATION=1 : une variable manquante FAIT ÉCHOUER l'essai, jamais un saut silencieux.
describe("migrations d'un module (grappe jetable)", () => { // fiche: T2-35
  it("la variable de connexion de la grappe jetable est fournie (échec, pas saut)", () => {
    expect(ADMIN, "T235_PG_ADMIN_URL manque : le job socle-integration doit la fournir").toBeTruthy();
  });
  it("[A-219] les migrations du module d'essai sont appliquées dans a_<code>, par le rôle de migration du module, et rejouables", async () => {
    const c = await clientNonFerme();
    await migrerBase(c.base, 1, { url: vers(c.base), dossier: ESSAI, module: "essai" });
    await migrerBase(c.base, 1, { url: vers(c.base), dossier: ESSAI, module: "essai" });
    const m = roleMigrationModule(c.base, "essai");
    const t = await c.dans.query("SELECT tableowner FROM pg_tables WHERE schemaname = 'a_essai' AND tablename = 'essai_notes'");
    // Barrière de droits : les objets du module appartiennent au rôle de migration PROPRE au module, pas au propriétaire de la base.
    expect(t.rows[0]?.tableowner).toBe(m);
    expect(await comme(c, m, "SELECT version FROM a_essai.version_structure")).toEqual([{ version: 1 }]);
    expect((await c.dans.query("SELECT count(*)::int AS n FROM pg_tables WHERE tablename = 'essai_notes' AND schemaname <> 'a_essai'")).rows[0]?.n).toBe(0);
    // L'application lit et écrit dans le schéma du module, sans DELETE.
    expect((await comme(c, c.roles.proprietaire, "SELECT has_table_privilege($1, 'a_essai.essai_notes', 'INSERT') AS i, has_table_privilege($1, 'a_essai.essai_notes', 'DELETE') AS d", [c.roles.app]))[0]).toEqual({ i: true, d: false });
  }, 60_000);

  it("[A-219] @isolation le rôle de migration du module ne possède et n'écrit que a_<code> : rien dans commun ni public, même sans le filtre du texte", async () => {
    const c = await clientNonFerme();
    await migrerBase(c.base, 1, { url: vers(c.base), dossier: ESSAI, module: "essai" });
    const m = roleMigrationModule(c.base, "essai");
    const q = async (sql: string) => (await c.dans.query(sql)).rows[0] as Record<string, boolean>;
    expect(await q(`SELECT has_schema_privilege('${m}', 'commun', 'USAGE') AS u, has_schema_privilege('${m}', 'commun', 'CREATE') AS c, has_schema_privilege('${m}', 'public', 'CREATE') AS p`)).toEqual({ u: false, c: false, p: false });
    // Après la migration, le provisionneur ne garde pas la main sur ce rôle (il ne lirait pas les données du module d'un client fermé).
    await c.dans.query("RESET ROLE");
    await expect(c.dans.query(`SET ROLE ${m}`)).rejects.toMatchObject({ code: "42501" });
    // Sous ce rôle, même les ordres que le filtre laisserait passer échouent hors du schéma du module.
    await c.dans.query(`GRANT ${m} TO CURRENT_USER WITH SET TRUE`);
    const k = new pg.Client({ connectionString: vers(c.base) });
    await k.connect();
    try {
      await k.query(`SET ROLE ${m}`);
      for (const sql of ["CREATE TABLE commun.vole (id int)", "CREATE TABLE public.vole (id int)", "DELETE FROM commun.personnes", "UPDATE commun.personnes SET nom = nom", "TRUNCATE commun.personnes", "ALTER TABLE commun.personnes DISABLE ROW LEVEL SECURITY", "INSERT INTO commun.exclusions DEFAULT VALUES"]) {
        await expect(k.query(sql), sql).rejects.toMatchObject({ code: "42501" });
      }
      await k.query("COMMIT").catch(() => undefined);
      await k.query("CREATE TABLE a_essai.autre (id int)");
    } finally { await k.end(); }
    // L'application ne touche pas au journal de versions du module.
    expect((await comme(c, c.roles.proprietaire, "SELECT has_table_privilege($1, 'a_essai.version_structure', 'SELECT') AS s", [c.roles.app]))[0]).toEqual({ s: false });
  }, 60_000);

  it("[A-219] @isolation une migration qui crée un objet hors a_<code> est refusée avant toute exécution, même masquée, et ne laisse rien", async () => {
    const c = await clientNonFerme();
    // Nom de schéma écrit en échappement Unicode : le texte ne le montre pas, le comptage des objets le voit.
    const d = dossierAvec('CREATE TABLE U&"\\0063ommun"."vole" (id int);');
    await expect(migrerBase(c.base, 1, { url: vers(c.base), dossier: d, module: "essai" })).rejects.toThrow(/refusées/);
    expect((await c.dans.query("SELECT count(*)::int AS n FROM pg_tables WHERE tablename = 'vole'")).rows[0]?.n).toBe(0);
    expect((await c.dans.query("SELECT count(*)::int AS n FROM pg_namespace WHERE nspname = 'a_essai'")).rows[0]?.n).toBe(0);
  }, 60_000);
});
