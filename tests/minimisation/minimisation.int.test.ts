import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// T2-47 : sonde de minimisation. Un marqueur unique par essai est déposé dans la base d'un client fictif ; la sonde vérifie qu'on le retrouve dans cette base et nulle part ailleurs.
// ATTENTION : ce n'est PAS la garde de bout en bout. Le dépôt se fait ici directement en SQL, sans passer par la plateforme (pas de route d'import dans apps/api/src à ce jour).
// Dette LOT2-dette-T2-47-garde (fiche T2-47b) : faire entrer le marqueur par l'API d'import.
// Cibles (grappe jetable, jamais de vraies données) : six variables de cible, voir « pret » ci-dessous. Toutes sont obligatoires.
// Sans elles ces essais sautent ; critère de la dette : le job « socle-integration » ÉCHOUE si l'une d'elles manque.
const E = process.env;
const PREFIXE = ["T2", "47"].join("");
const nom = (suffixe: string) => `${PREFIXE}_${suffixe}`;
const VARIABLES = ["CLIENT_URL", "CONSOLE_URL", "MOTEUR_URL", "VALKEY_URL", "JOURNAUX", "COMMUNS"].map(nom);
const pret = VARIABLES.every((v) => Boolean(E[v]));
const api = createRequire(new URL("../../apps/api/package.json", import.meta.url));
const nouveauMarqueur = () => `MARQUEUR-ESSAI-${randomBytes(12).toString("hex")}`;

type Requeteur = { query(t: string, v?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>; end(): Promise<void> };
async function ouvrir(url: string): Promise<Requeteur> {
  const pg = api("pg") as typeof import("pg");
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  return c as unknown as Requeteur;
}

// Toutes les colonnes texte, jsonb, bytea, tableaux et types définis (citext…) de toutes les tables, listées depuis information_schema (présentes et futures), jamais à la main.
export async function ouTrouverEnBase(c: Requeteur, marqueur: string): Promise<string[]> {
  const cols = await c.query(
    `SELECT c.table_schema, c.table_name, c.column_name, c.data_type FROM information_schema.columns c JOIN information_schema.tables t USING (table_schema, table_name)
     WHERE t.table_type = 'BASE TABLE' AND c.table_schema NOT IN ('pg_catalog', 'information_schema') AND c.data_type IN ('text', 'character varying', 'character', 'jsonb', 'json', 'bytea', 'ARRAY', 'USER-DEFINED')`,
  );
  const trouves: string[] = [];
  for (const { table_schema: s, table_name: t, column_name: k, data_type: d } of cols.rows as { table_schema: string; table_name: string; column_name: string; data_type: string }[]) {
    const test = d === "bytea" ? `position(convert_to($1, 'UTF8') in "${k}") > 0` : `position($1 in "${k}"::text) > 0`;
    const r = await c.query(`SELECT 1 FROM "${s}"."${t}" WHERE ${test} LIMIT 1`, [marqueur]);
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
        // Longueur mesurée (llen/zcard/xlen), seulement sur les listes d'attente BullMQ ; completed/failed ne sont pas exigées vides : on y cherche le marqueur (ci-dessus).
        if (/:(wait|active|delayed)$/.test(cle)) {
          const n = type === "list" ? await r.llen(cle) : type === "zset" ? await r.zcard(cle) : type === "stream" ? await r.xlen(cle) : 0;
          if (n > 0) filesNonVides.push(cle);
        }
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

describe.skipIf(!pret)("sonde de minimisation (pas la garde de bout en bout : dette LOT2-dette-T2-47-garde)", () => { // fiche: T2-48
  async function deposer(marqueur: string): Promise<{ client: Requeteur; id: unknown }> {
    const client = await ouvrir(E[nom("CLIENT_URL")] as string);
    const etab = await client.query("INSERT INTO commun.etablissements (nom) VALUES ('Atelier Bertin') RETURNING id");
    const p = await client.query("INSERT INTO commun.personnes (etablissement_id, nom) VALUES ($1, $2) RETURNING id", [etab.rows[0]?.["id"], marqueur]);
    return { client, id: p.rows[0]?.["id"] };
  }

  it("le marqueur déposé dans la base du client est absent de la console, du moteur, de Valkey, des journaux et des compartiments communs", async () => {
    const marqueur = nouveauMarqueur();
    const { client } = await deposer(marqueur);
    const console_ = await ouvrir(E[nom("CONSOLE_URL")] as string);
    const moteur = await ouvrir(E[nom("MOTEUR_URL")] as string);
    try {
      // Preuve que la recherche fonctionne : le marqueur est bien trouvable dans la base du client.
      expect(await ouTrouverEnBase(client, marqueur)).toContain("commun.personnes.nom");
      expect(await ouTrouverEnBase(console_, marqueur)).toEqual([]);
      expect(await ouTrouverEnBase(moteur, marqueur)).toEqual([]);
      const valkey = await ouTrouverDansValkey(E[nom("VALKEY_URL")] as string, marqueur);
      expect(valkey.trouves).toEqual([]);
      expect(valkey.filesNonVides).toEqual([]);
      expect(ouTrouverDansFichiers(E[nom("JOURNAUX")] as string, marqueur)).toEqual([]);
      expect(ouTrouverDansFichiers(E[nom("COMMUNS")] as string, marqueur)).toEqual([]);
    } finally {
      await Promise.all([client.end(), console_.end(), moteur.end()]);
    }
  }, 120_000);

  it("[C-043] sans purge, la ligne déposée reste dans la base du client en un seul exemplaire (un marqueur par essai)", async () => {
    const marqueur = nouveauMarqueur();
    const { client, id } = await deposer(marqueur);
    try {
      const r = await client.query("SELECT id FROM commun.personnes WHERE nom = $1", [marqueur]);
      expect(r.rows).toHaveLength(1);
      expect(r.rows[0]?.["id"]).toEqual(id);
    } finally {
      await client.end();
    }
  }, 60_000);

  // DETTE LOT2-dette-T2-47-garde : aucune route d'import n'existe dans apps/api/src ; tant qu'elle manque, la garde de bout en bout ne peut pas être écrite.
  it.todo("un marqueur importé par l'API, passé par une exécution d'essai puis le lot de nuit, est absent de console, moteur, Valkey, journaux API et CI et compartiments communs");
});
