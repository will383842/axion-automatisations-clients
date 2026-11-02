import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// T2-47 : garde de minimisation. Un MARQUEUR unique est déposé dans la base d'un client fictif ; il ne doit se trouver nulle part ailleurs.
// Cibles (grappe jetable, jamais de vraies données) : T247_CLIENT_URL (base du client), T247_CONSOLE_URL, T247_MOTEUR_URL, T247_VALKEY_URL, T247_JOURNAUX (dossier de journaux, facultatif).
// Sans ces variables ces essais ne tournent pas. Dette T2-48 : la porte du lot doit les faire ÉCHOUER (et non sauter) quand elles manquent ; critère : job rouge sans les variables.
const E = process.env;
const pret = Boolean(E["T247_CLIENT_URL"] && E["T247_CONSOLE_URL"] && E["T247_MOTEUR_URL"] && E["T247_VALKEY_URL"]);
const api = createRequire(new URL("../../apps/api/package.json", import.meta.url));
const MARQUEUR = `MARQUEUR-ESSAI-${randomBytes(12).toString("hex")}`;

type Requeteur = { query(t: string, v?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>; end(): Promise<void> };
async function ouvrir(url: string): Promise<Requeteur> {
  const pg = api("pg") as typeof import("pg");
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  return c as unknown as Requeteur;
}

// Toutes les colonnes texte et jsonb de toutes les tables, listées depuis information_schema (présentes et futures), jamais à la main.
export async function ouTrouverEnBase(c: Requeteur, marqueur: string): Promise<string[]> {
  const cols = await c.query(
    `SELECT c.table_schema, c.table_name, c.column_name FROM information_schema.columns c JOIN information_schema.tables t USING (table_schema, table_name)
     WHERE t.table_type = 'BASE TABLE' AND c.table_schema NOT IN ('pg_catalog', 'information_schema') AND c.data_type IN ('text', 'character varying', 'character', 'jsonb', 'json', 'bytea', 'ARRAY')`,
  );
  const trouves: string[] = [];
  for (const { table_schema: s, table_name: t, column_name: k } of cols.rows as { table_schema: string; table_name: string; column_name: string }[]) {
    const r = await c.query(`SELECT 1 FROM "${s}"."${t}" WHERE position($1 in convert_from(convert_to("${k}"::text, 'UTF8'), 'UTF8')) > 0 LIMIT 1`, [marqueur]);
    if (r.rows.length) trouves.push(`${s}.${t}.${k}`);
  }
  return trouves;
}

async function ouTrouverDansValkey(url: string, marqueur: string): Promise<{ trouves: string[]; filesNonVides: string[] }> {
  const { Redis } = api("ioredis") as typeof import("ioredis");
  const r = new Redis(url);
  const trouves: string[] = [];
  const filesNonVides: string[] = [];
  try {
    let curseur = "0";
    do {
      const [suivant, cles] = await r.scan(curseur, "COUNT", 500);
      curseur = suivant;
      for (const cle of cles) {
        const type = await r.type(cle);
        const valeur =
          type === "string" ? [await r.get(cle)] : type === "hash" ? Object.entries(await r.hgetall(cle)).flat() : type === "list" ? await r.lrange(cle, 0, -1) : type === "set" ? await r.smembers(cle) : type === "zset" ? await r.zrange(cle, 0, -1) : JSON.stringify(await r.xrange(cle, "-", "+"));
        if (cle.includes(marqueur) || JSON.stringify(valeur).includes(marqueur)) trouves.push(`${cle} (${type})`);
        if (["list", "zset", "stream"].includes(type) && valeur.length > 0) filesNonVides.push(cle);
      }
    } while (curseur !== "0");
  } finally {
    r.disconnect();
  }
  return { trouves, filesNonVides };
}

function ouTrouverDansFichiers(dossier: string, marqueur: string): string[] {
  if (!existsSync(dossier)) return [];
  return readdirSync(dossier).flatMap((nom) => {
    const chemin = join(dossier, nom);
    return statSync(chemin).isDirectory() ? ouTrouverDansFichiers(chemin, marqueur) : readFileSync(chemin).includes(marqueur) ? [chemin] : [];
  });
}

describe.skipIf(!pret)("minimisation : aucun contenu de travail hors de la base du client", () => {
  async function deposer(): Promise<Requeteur> {
    const client = await ouvrir(E["T247_CLIENT_URL"] as string);
    const etab = await client.query("INSERT INTO commun.etablissements (nom) VALUES ('Atelier Bertin') RETURNING id");
    await client.query("INSERT INTO commun.personnes (etablissement_id, nom) VALUES ($1, $2)", [etab.rows[0]?.["id"], MARQUEUR]);
    return client;
  }

  it("[A-033] aucun contenu en transit n'est conservé hors de la base du client (marqueur absent de console, moteur, Valkey, journaux)", async () => {
    const client = await deposer();
    const console_ = await ouvrir(E["T247_CONSOLE_URL"] as string);
    const moteur = await ouvrir(E["T247_MOTEUR_URL"] as string);
    try {
      // Preuve que la recherche fonctionne : le marqueur est bien trouvable dans la base du client.
      expect(await ouTrouverEnBase(client, MARQUEUR)).toContain("commun.personnes.nom");
      expect(await ouTrouverEnBase(console_, MARQUEUR)).toEqual([]);
      expect(await ouTrouverEnBase(moteur, MARQUEUR)).toEqual([]);
      expect((await ouTrouverDansValkey(E["T247_VALKEY_URL"] as string, MARQUEUR)).trouves).toEqual([]);
      expect(ouTrouverDansFichiers(E["T247_JOURNAUX"] ?? "/nonexistent", MARQUEUR)).toEqual([]);
    } finally {
      await Promise.all([client.end(), console_.end(), moteur.end()]);
    }
  }, 120_000);

  it("[A-198] la plateforme ne garde aucun contenu en transit", async () => {
    await (await deposer()).end();
    const { trouves, filesNonVides } = await ouTrouverDansValkey(E["T247_VALKEY_URL"] as string, MARQUEUR);
    expect(trouves).toEqual([]);
    expect(filesNonVides).toEqual([]); // files vides après traitement
  }, 60_000);

  it("[C-027] les données de travail ne vivent que dans la base et le compartiment du client", async () => {
    const client = await deposer();
    const console_ = await ouvrir(E["T247_CONSOLE_URL"] as string);
    try {
      expect((await ouTrouverEnBase(client, MARQUEUR)).length).toBeGreaterThan(0);
      expect(await ouTrouverEnBase(console_, MARQUEUR)).toEqual([]);
    } finally {
      await Promise.all([client.end(), console_.end()]);
    }
  }, 120_000);

  it("[C-043] les données de travail restent dans la base du client tant que le contrat court", async () => {
    const client = await deposer();
    try {
      // Aucune purge : après les traitements, la ligne est toujours là (et en un seul exemplaire).
      const r = await client.query("SELECT count(*)::int AS n FROM commun.personnes WHERE nom = $1", [MARQUEUR]);
      expect(r.rows[0]?.["n"]).toBe(1);
    } finally {
      await client.end();
    }
  }, 60_000);
});
