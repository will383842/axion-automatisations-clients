import { randomBytes } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

// Dette T2-34 : le job socle-integration doit ÉCHOUER (et non sauter ces essais) quand T232_PG_ADMIN_URL manque ; critère : job rouge sans la variable.
describe.skipIf(!ADMIN)("modèle de base client (grappe jetable)", () => { // fiche: T2-34
  // Le modèle est construit une fois, avant tous les essais : aucun ne dépend de l'ordre des autres.
  beforeAll(async () => {
    await construireModele(N, { url: vers("postgres") });
  }, 60_000);

  it("[A-207] une base créée depuis modele_vN a les schémas commun et trace et la table version_structure", async () => {
    const t = await admin.query("SELECT datistemplate, datallowconn FROM pg_database WHERE datname = $1", [`modele_v${N}`]);
    expect(t.rows[0]).toEqual({ datistemplate: true, datallowconn: false });
    // CONNECT retiré à PUBLIC (aucune ligne d'ACL pour le grantee 0) et dernière version notée sur le modèle.
    const acl = await admin.query("SELECT count(*)::int AS n FROM pg_database d, aclexplode(d.datacl) a WHERE d.datname = $1 AND a.grantee = 0 AND a.privilege_type = 'CONNECT'", [`modele_v${N}`]);
    expect(acl.rows[0]?.n).toBe(0);
    expect((await admin.query("SELECT shobj_description(oid, 'pg_database') AS c FROM pg_database WHERE datname = $1", [`modele_v${N}`])).rows[0]?.c).toBe("version_structure=1");
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

  it("[A-212] les droits posés par migrerBase : _app lit et écrit commun et insère dans trace, _lecture lit, aucun n'écrit version_structure", async () => {
    const base = await creerClient();
    await migrerBase(base, 1, { url: vers(base) });
    await admin.query(`GRANT "${base}_app", "${base}_lecture" TO CURRENT_USER`);
    const app = (f: (c: pg.Client) => Promise<unknown>) => sur(base, f, `${base}_app`);
    const lecture = (f: (c: pg.Client) => Promise<unknown>) => sur(base, f, `${base}_lecture`);
    await app((c) => c.query("INSERT INTO commun.etablissements (nom) VALUES ('Siège Garage Fontaine')"));
    await app((c) => c.query("INSERT INTO trace.evenements (qui, quoi, objet) VALUES ('agent-essai', 'export', 'liste d''essai')"));
    await expect(app((c) => c.query("INSERT INTO public.version_structure(version, empreinte) VALUES (99, 'x')"))).rejects.toThrow(/permission|privilège/i);
    await expect(app((c) => c.query("DELETE FROM commun.etablissements"))).rejects.toThrow(/permission|privilège/i);
    // Aucun DELETE accordé, même sur la table de liaison des listes ; une opposition ne se modifie ni ne s'efface.
    await expect(app((c) => c.query("DELETE FROM commun.listes_prospects_personnes"))).rejects.toThrow(/permission|privilège/i);
    await app((c) => c.query("INSERT INTO commun.exclusions (genre, empreinte) VALUES ('courriel', decode(repeat('ab', 32), 'hex'))"));
    await expect(app((c) => c.query("UPDATE commun.exclusions SET genre = 'telephone'"))).rejects.toThrow(/permission|privilège/i);
    await expect(app((c) => c.query("DELETE FROM commun.exclusions"))).rejects.toThrow(/permission|privilège/i);
    await expect(app((c) => c.query("INSERT INTO commun.exclusions (genre, empreinte) VALUES ('courriel', '\\x00')"))).rejects.toThrow(/exclusions_empreinte_taille/);
    expect(await lecture(async (c) => (await c.query("SELECT count(*)::int AS n FROM commun.etablissements")).rows[0]?.n)).toBe(1);
    await expect(lecture((c) => c.query("INSERT INTO commun.etablissements (nom) VALUES ('x')"))).rejects.toThrow(/permission|privilège/i);
    await expect(lecture((c) => c.query("INSERT INTO trace.evenements (qui, quoi, objet) VALUES ('a', 'import', 'b')"))).rejects.toThrow(/permission|privilège/i);
  });

  it("[A-212] on sort quelqu'un d'une liste en marquant retire_le, sans suppression", async () => {
    const base = await creerClient();
    await migrerBase(base, 1, { url: vers(base) });
    await admin.query(`GRANT "${base}_app" TO CURRENT_USER`);
    await sur(base, async (c) => {
      const e = (await c.query("INSERT INTO commun.etablissements (nom) VALUES ('Siège Boulangerie Rivoire') RETURNING id")).rows[0]?.id;
      const p = (await c.query("INSERT INTO commun.personnes (etablissement_id, nom) VALUES ($1, 'Essai Personne') RETURNING id", [e])).rows[0]?.id;
      const l = (await c.query("INSERT INTO commun.listes_prospects (etablissement_id, nom) VALUES ($1, 'Liste essai') RETURNING id", [e])).rows[0]?.id;
      await c.query("INSERT INTO commun.listes_prospects_personnes (liste_id, personne_id) VALUES ($1, $2)", [l, p]);
      await c.query("UPDATE commun.listes_prospects_personnes SET retire_le = now()");
      expect((await c.query("SELECT count(*)::int AS n FROM commun.listes_prospects_personnes WHERE retire_le IS NOT NULL")).rows[0]?.n).toBe(1);
    }, `${base}_app`);
  });

  it("[C-034] un prénom, un type de contenu trop longs ou une empreinte qui n'a pas 32 octets sont refusés", async () => {
    const base = await creerClient();
    await sur(base, async (c) => {
      const e = (await c.query("INSERT INTO commun.etablissements (nom) VALUES ('Siège Garage Fontaine') RETURNING id")).rows[0]?.id;
      await expect(c.query("INSERT INTO commun.personnes (etablissement_id, nom, prenom) VALUES ($1, 'N', repeat('x', 501))", [e])).rejects.toThrow(/prenom_longueur/);
      await expect(c.query("INSERT INTO commun.personnes (etablissement_id, nom, courriel_empreinte) VALUES ($1, 'N', '\\x00')", [e])).rejects.toThrow(/empreinte_taille/);
      await expect(c.query("INSERT INTO commun.index_fichiers (etablissement_id, cle_objet, empreinte, taille_octets, type_contenu) VALUES ($1, 'k', repeat('a', 64), 1, repeat('x', 501))", [e])).rejects.toThrow(/type_longueur/);
    }, `${base}_proprietaire`);
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
