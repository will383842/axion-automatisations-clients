import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { migrer } from "./migrer.js";

// Tests contre le socle lancé par ops/socle/lancer.sh (job socle-integration), même méthode que roles.int.test.ts.
const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8" }).trim();
const conteneur = (service: string) =>
  docker("ps", "-q", "--filter", "label=com.docker.compose.project=socle", "--filter", `label=com.docker.compose.service=${service}`);
function adresse(service: string, port: number, surcharge: string | undefined): string {
  if (surcharge) return surcharge;
  return `${docker("inspect", "-f", '{{(index .NetworkSettings.Networks "socle_interne").IPAddress}}', conteneur(service))}:${port}`;
}
function secret(): string {
  if (process.env["SOCLE_PG_MOT_DE_PASSE"]) return process.env["SOCLE_PG_MOT_DE_PASSE"];
  const variables = docker("inspect", "-f", "{{range .Config.Env}}{{println .}}{{end}}", conteneur("postgres")).split("\n");
  const ligne = variables.find((l) => l.startsWith("SOCLE_PG_MOT_DE_PASSE="));
  if (!ligne) throw new Error("mot de passe de test introuvable");
  return ligne.slice("SOCLE_PG_MOT_DE_PASSE=".length);
}
const motDePasseDe = (role: string) => createHash("sha256").update(`${secret()}/${role}`).digest("hex");
const urlDe = (role: string, hote: string) => `postgres://${role}:${motDePasseDe(role)}@${hote}/console`;
const DIRECT = () => adresse("postgres", 5432, process.env["SOCLE_PG_DIRECT"]);

// Migration d'essai : dossier temporaire du test, jamais apps/api/drizzle/.
function dossierEssai(): string {
  const dossier = mkdtempSync(join(tmpdir(), "migrer-"));
  mkdirSync(join(dossier, "meta"));
  writeFileSync(join(dossier, "0000_essai.sql"), "CREATE TABLE essai_migration_a189 (id integer);\n");
  writeFileSync(
    join(dossier, "meta/_journal.json"),
    JSON.stringify({ version: "7", dialect: "postgresql", entries: [{ idx: 0, version: "7", when: 1700000000000, tag: "0000_essai", breakpoints: true }] }),
  );
  return dossier;
}

describe("migrer, avec le socle", () => {
  it("[A-189] migrer applique une migration d'essai avec console_migration et refuse de tourner avec console_app", async () => {
    const dossier = dossierEssai();
    await expect(migrer({ url: urlDe("console_app", DIRECT()), dossier })).rejects.toThrow(/console_migration/);
    await migrer({ url: urlDe("console_migration", DIRECT()), dossier });
    const equipe = new pg.Client({ connectionString: urlDe("console_equipe", DIRECT()) });
    await equipe.connect();
    try {
      const table = await equipe.query("SELECT to_regclass('public.essai_migration_a189') AS t");
      expect(table.rows[0]?.["t"]).toBe("essai_migration_a189");
      const journal = await equipe.query("SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations");
      expect(journal.rows[0]?.["n"]).toBe(1);
    } finally {
      await equipe.end();
    }
    // Rejouée, la migration ne s'applique pas deux fois.
    await migrer({ url: urlDe("console_migration", DIRECT()), dossier });
  });

  it("[A-189] attaque : migrer vérifie le rôle réel de la session, pas seulement le nom dans l'URL", async () => {
    // Le mot de passe de console_app avec le nom console_migration est refusé par la base : aucune migration ne passe.
    const mauvais = `postgres://console_migration:${motDePasseDe("console_app")}@${DIRECT()}/console`;
    await expect(migrer({ url: mauvais, dossier: dossierEssai() })).rejects.toThrow();
  });
});
