import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, writeSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { executerLecture } from "@axion-auto/donnees-module";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lireYaml } from "../../../../../scripts/garde-compose.js";
import { journalEchecs } from "../../provisionnement/journal-echecs.js";
journalEchecs(import.meta.url);

// Essai réel (job socle-integration, Docker) : lancé seulement en CI, aucun résultat inventé hors CI.
const racine = (chemin: string) => fileURLToPath(new URL(`../../../../../${chemin}`, import.meta.url));
const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8" }).trim();
let conteneur = "";
let pool!: pg.Pool;

beforeAll(async () => {
  const image = (lireYaml(readFileSync(racine("ops/socle/compose.postgres.yml"), "utf8")) as unknown as { services: Record<string, { image: string }> }).services["postgres"]!.image;
  const mdp = randomBytes(16).toString("hex");
  conteneur = docker("run", "-d", "--rm", "-e", `POSTGRES_PASSWORD=${mdp}`, image);
  const hote = docker("inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}", conteneur).split(" ")[0] ?? "";
  pool = new pg.Pool({ host: hote, user: "postgres", password: mdp, database: "postgres", max: 1 });
  for (let i = 0; ; i++) {
    try { await pool.query("SELECT 1"); break; } catch (e) {
      if (i > 90) { writeSync(2, `EXECUTER-INT PostgreSQL non démarré : ${(e as Error).name}\n`); throw e; }
      await new Promise((ok) => setTimeout(ok, 500));
    }
  }
}, 120_000);
afterAll(async () => {
  await pool?.end().catch(() => undefined);
  if (conteneur) try { docker("rm", "-f", conteneur); } catch { /* déjà arrêté */ }
});

describe("executerLecture sur un vrai PostgreSQL", () => {
  it("[A-170] executerLecture ouvre une transaction READ ONLY avec statement_timeout", async () => {
    const client = await pool.connect();
    let casse: Error | undefined;
    try {
      const vu = await executerLecture(client, { texte: "SELECT current_setting('transaction_read_only') AS ro, current_setting('statement_timeout') AS delai, $1::int AS n", valeurs: [1] }, { delaiMs: 1500 });
      expect(vu).toEqual([{ ro: "on", delai: "1500ms", n: 1 }]);
      // Une écriture est refusée par la base (transaction en lecture seule) et le délai coupe une requête lente.
      await expect(executerLecture(client, { texte: "CREATE TEMP TABLE essai AS SELECT $1::int AS a", valeurs: [1] }, { delaiMs: 1500 })).rejects.toMatchObject({ code: "25006" });
      await expect(executerLecture(client, { texte: "SELECT pg_sleep(5), $1::int", valeurs: [1] }, { delaiMs: 200 })).rejects.toMatchObject({ code: "57014" });
      // La connexion reste saine et ne garde ni le délai ni la lecture seule.
      const apres = await client.query("SELECT current_setting('transaction_read_only') AS ro, current_setting('statement_timeout') AS delai");
      expect(apres.rows).toEqual([{ ro: "off", delai: "0" }]);
    } catch (e) { if ((e as { connexionPerdue?: boolean }).connexionPerdue) casse = e as Error; throw e; } finally { client.release(casse); }
  }, 30_000);
});
