import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { migrerBase } from "../donnees/migrer-base.js";
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
const dossierAvec = (sql: string) => {
  const d = mkdtempSync(join(tmpdir(), "mod-"));
  mkdirSync(`${d}/meta`);
  writeFileSync(`${d}/0000_x.sql`, sql);
  writeFileSync(`${d}/meta/_journal.json`, JSON.stringify({ version: "7", dialect: "postgresql", entries: [{ idx: 0, version: "7", when: 1793612974019, tag: "0000_x", breakpoints: true }] }));
  return d;
};

describe.skipIf(!ADMIN)("migrations d'un module (grappe jetable)", () => {
  it("[A-219] les migrations du module d'essai sont appliquées dans a_<code>, par le propriétaire, et rejouables", async () => {
    const c = await clientNonFerme();
    await migrerBase(c.base, 1, { url: vers(c.base), dossier: ESSAI, module: "essai" });
    await migrerBase(c.base, 1, { url: vers(c.base), dossier: ESSAI, module: "essai" });
    const t = await c.dans.query("SELECT tableowner FROM pg_tables WHERE schemaname = 'a_essai' AND tablename = 'essai_notes'");
    expect(t.rows[0]?.tableowner).toBe(c.roles.proprietaire);
    expect((await c.dans.query("SELECT version FROM a_essai.version_structure")).rows).toEqual([{ version: 1 }]);
    expect((await c.dans.query("SELECT count(*)::int AS n FROM pg_tables WHERE tablename = 'essai_notes' AND schemaname <> 'a_essai'")).rows[0]?.n).toBe(0);
    // L'application lit et écrit dans le schéma du module, sans DELETE.
    expect((await c.dans.query("SELECT has_table_privilege($1, 'a_essai.essai_notes', 'INSERT') AS i, has_table_privilege($1, 'a_essai.essai_notes', 'DELETE') AS d", [c.roles.app])).rows[0]).toEqual({ i: true, d: false });
  }, 60_000);

  it("[A-219] @isolation une migration qui crée un objet hors a_<code> est refusée, même masquée, et ne laisse rien", async () => {
    const c = await clientNonFerme();
    // Nom de schéma écrit en échappement Unicode : le texte ne le montre pas, le comptage des objets le voit.
    const d = dossierAvec('CREATE TABLE U&"\\0063ommun"."vole" (id int);');
    await expect(migrerBase(c.base, 1, { url: vers(c.base), dossier: d, module: "essai" })).rejects.toThrow();
    expect((await c.dans.query("SELECT count(*)::int AS n FROM pg_tables WHERE tablename = 'vole'")).rows[0]?.n).toBe(0);
    expect((await c.dans.query("SELECT count(*)::int AS n FROM a_essai.version_structure")).rows[0]?.n).toBe(0);
  }, 60_000);
});
