import { randomBytes } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { construireModele, migrerBase } from "./migrer-base.ts";

// T2-32 : modèle modele_vN et outil de migration, contre une grappe PostgreSQL où un rôle administrateur peut créer des bases et des rôles
// (variable T232_PG_ADMIN_URL, adresse d'une grappe jetable ; sans elle, ces essais ne tournent pas). Aucun secret dans le dépôt.
const ADMIN = process.env["T232_PG_ADMIN_URL"];
const DOSSIER = fileURLToPath(new URL("../../drizzle-cli", import.meta.url));
const vers = (base: string) => {
  const u = new URL(ADMIN ?? "postgres://x@localhost/postgres");
  u.pathname = `/${base}`;
  return u.toString();
};
const hex = () => randomBytes(6).toString("hex");
const N = 9000 + Math.floor(Math.random() * 900);
const bases: string[] = [];
const admin = new pg.Pool({ connectionString: ADMIN, max: 2 });

async function sur<T>(base: string, f: (c: pg.Client) => Promise<T>, role?: string): Promise<T> {
  const c = new pg.Client({ connectionString: vers(base) });
  await c.connect();
  try {
    if (role) await c.query(`SET ROLE "${role}"`);
    return await f(c);
  } finally {
    await c.end();
  }
}
// Recette réduite (la vraie est ops/socle/donnees/creer-base.sql) : trois rôles, base depuis le modèle, objets rendus au propriétaire.
async function creerClient(): Promise<string> {
  const id = hex();
  const base = `cli_${id}`;
  for (const r of ["proprietaire", "app", "lecture"]) await admin.query(`CREATE ROLE "${base}_${r}" ${r === "proprietaire" ? "NOLOGIN" : "NOLOGIN"}`);
  await admin.query(`CREATE DATABASE "${base}" TEMPLATE "modele_v${N}" OWNER "${base}_proprietaire"`);
  bases.push(base);
  await sur(base, (c) => c.query(`REASSIGN OWNED BY modele_proprietaire TO "${base}_proprietaire"`));
  return base;
}

describe.skipIf(!ADMIN)("modèle de base client (grappe jetable)", () => {
  it("[A-207] une base créée depuis modele_vN a les schémas commun et trace et la table version_structure", async () => {
    await construireModele(N, { url: vers("postgres") });
    const t = await admin.query("SELECT datistemplate, datallowconn FROM pg_database WHERE datname = $1", [`modele_v${N}`]);
    expect(t.rows[0]).toEqual({ datistemplate: true, datallowconn: false });
    const base = await creerClient();
    const r = await sur(base, (c) => c.query("SELECT nspname FROM pg_namespace WHERE nspname IN ('commun','trace') UNION ALL SELECT table_name FROM information_schema.tables WHERE table_name = 'version_structure'"));
    expect(r.rows.map((x) => x.nspname).sort()).toEqual(["commun", "trace", "version_structure"]);
  }, 60_000);

  it("[A-225] chaque base porte sa version de structure", async () => {
    const base = await creerClient();
    const v = await sur(base, async (c) => (await c.query("SELECT version FROM public.version_structure ORDER BY version")).rows.map((x) => x.version));
    expect(v).toEqual([1]);
  });

  it("[A-174] migrerBase applique dans l'ordre les migrations manquantes et met la version à jour", async () => {
    const base = await creerClient();
    const copie = mkdtempSync(join(tmpdir(), "cli-"));
    cpSync(DOSSIER, copie, { recursive: true });
    const journal = JSON.parse(readFileSync(join(copie, "meta/_journal.json"), "utf8"));
    journal.entries.push({ idx: 1, version: "7", when: journal.entries[0].when + 1000, tag: "0001_essai", breakpoints: true });
    writeFileSync(join(copie, "meta/_journal.json"), JSON.stringify(journal));
    writeFileSync(join(copie, "0001_essai.sql"), 'ALTER TABLE "commun"."etablissements" ADD COLUMN "note_essai" text;');
    await migrerBase(base, 2, { url: vers(base), dossier: copie });
    const r = await sur(base, async (c) => ({
      v: (await c.query("SELECT version FROM public.version_structure ORDER BY version")).rows.map((x) => x.version),
      col: (await c.query("SELECT 1 FROM information_schema.columns WHERE table_name='etablissements' AND column_name='note_essai'")).rowCount,
    }));
    expect(r).toEqual({ v: [1, 2], col: 1 });
    await migrerBase(base, 2, { url: vers(base), dossier: copie }); // rejouer ne change rien
  }, 60_000);

  it("[A-212] migrerBase refuse de tourner avec le rôle application : même en base, le rôle _app n'écrit pas version_structure", async () => {
    const base = await creerClient();
    await admin.query(`GRANT "${base}_app" TO CURRENT_USER`);
    await expect(sur(base, (c) => c.query("INSERT INTO public.version_structure(version, empreinte) VALUES (99, 'x')"), `${base}_app`)).rejects.toThrow(/permission|privilège/i);
  });

  it("[B-173] une personne sans établissement est refusée", async () => {
    const base = await creerClient();
    await expect(sur(base, (c) => c.query("INSERT INTO commun.personnes (nom) VALUES ('Dupont Essai')"), `${base}_proprietaire`)).rejects.toThrow(/etablissement_id/);
  });

  it("[B-348] deux bases créées depuis le même modèle ne partagent aucune ligne", async () => {
    const a = await creerClient();
    const b = await creerClient();
    await sur(a, (c) => c.query("INSERT INTO commun.etablissements (nom) VALUES ('Siège Atelier Bertin')"), `${a}_proprietaire`);
    expect(await sur(b, async (c) => (await c.query("SELECT count(*)::int AS n FROM commun.etablissements")).rows[0]?.n)).toBe(0);
    expect(await sur(a, async (c) => (await c.query("SELECT count(*)::int AS n FROM commun.etablissements")).rows[0]?.n)).toBe(1);
  });

  it("[A-207] la trace refuse UPDATE et DELETE", async () => {
    const base = await creerClient();
    await sur(base, async (c) => {
      await c.query("INSERT INTO trace.evenements (qui, quoi, objet) VALUES ('agent-essai', 'import', 'liste d''essai')");
      await expect(c.query("UPDATE trace.evenements SET qui = 'autre'")).rejects.toThrow(/ajout seul|refus/i);
      await expect(c.query("DELETE FROM trace.evenements")).rejects.toThrow(/ajout seul|refus/i);
      await expect(c.query("TRUNCATE trace.evenements")).rejects.toThrow(/ajout seul|refus/i);
    }, `${base}_proprietaire`);
  });
});

afterAll(async () => {
  // Essais seulement : nettoyage des bases et des rôles jetables créés ci-dessus (aucune donnée de client).
  for (const b of bases) {
    await admin.query(`DROP DATABASE IF EXISTS "${b}"`).catch(() => undefined);
    for (const r of ["proprietaire", "app", "lecture"]) await admin.query(`DROP ROLE IF EXISTS "${b}_${r}"`).catch(() => undefined);
  }
  await admin.query("UPDATE pg_database SET datistemplate = false WHERE datname = $1", [`modele_v${N}`]).catch(() => undefined);
  await admin.query(`DROP DATABASE IF EXISTS "modele_v${N}"`).catch(() => undefined);
  await admin.end().catch(() => undefined);
});
