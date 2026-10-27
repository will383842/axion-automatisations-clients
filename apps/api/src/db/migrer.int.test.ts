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
function dossierEssai(when = 1700000000000): string {
  const dossier = mkdtempSync(join(tmpdir(), "migrer-"));
  mkdirSync(join(dossier, "meta"));
  writeFileSync(join(dossier, "0000_essai.sql"), "CREATE TABLE essai_migration_a189 (id integer);\n");
  writeFileSync(
    join(dossier, "meta/_journal.json"),
    JSON.stringify({ version: "7", dialect: "postgresql", entries: [{ idx: 0, version: "7", when, tag: "0000_essai", breakpoints: true }] }),
  );
  return dossier;
}

describe("migrer, avec le socle", () => {
  it("[A-189] migrer applique une migration d'essai avec console_migration et refuse de tourner avec console_app", async () => {
    const dossier = dossierEssai();
    // Journal d'essai dans son propre schéma : public.__migrations ne reçoit jamais de migration d'essai (sauf l'essai dédié plus bas).
    const journal = { schema: "essai_a189", table: "__migrations" };
    await expect(migrer({ url: urlDe("console_app", DIRECT()), dossier, journal })).rejects.toThrow(/console_migration/);
    await migrer({ url: urlDe("console_migration", DIRECT()), dossier, journal });
    // Rejouée, la migration ne s'applique pas deux fois.
    await migrer({ url: urlDe("console_migration", DIRECT()), dossier, journal });
    // Lecture avec le rôle de migration (propriétaire du schéma d'essai) ; la table d'essai est retirée ensuite.
    const lecture = new pg.Client({ connectionString: urlDe("console_migration", DIRECT()) });
    await lecture.connect();
    try {
      const table = await lecture.query("SELECT to_regclass('public.essai_migration_a189')::text AS t");
      expect(table.rows[0]?.["t"]).toBe("essai_migration_a189");
      const journal = await lecture.query("SELECT count(*)::int AS n FROM essai_a189.__migrations");
      expect(journal.rows[0]?.["n"]).toBe(1);
    } finally {
      await lecture.query("DROP TABLE IF EXISTS public.essai_migration_a189; DROP SCHEMA IF EXISTS essai_a189 CASCADE").catch(() => undefined);
      await lecture.end();
    }
  });

  it("[A-189] attaque : migrer vérifie le rôle réel de la session, pas seulement le nom dans l'URL", async () => {
    // Le mot de passe de console_app avec le nom console_migration est refusé par la base : aucune migration ne passe.
    const mauvais = `postgres://console_migration:${motDePasseDe("console_app")}@${DIRECT()}/console`;
    await expect(migrer({ url: mauvais, dossier: dossierEssai() })).rejects.toThrow();
  });

  it("[A-233] B7 : migrer impose standard_conforming_strings = on, même si le serveur le règle sur off", async () => {
    const dossier = mkdtempSync(join(tmpdir(), "migrer-"));
    mkdirSync(join(dossier, "meta"));
    writeFileSync(join(dossier, "0000_scs.sql"), "CREATE TABLE essai_scs_a233 (id integer);\n--> statement-breakpoint\nCOMMENT ON TABLE essai_scs_a233 IS 'a\\';\n");
    writeFileSync(join(dossier, "meta/_journal.json"), JSON.stringify({ version: "7", dialect: "postgresql", entries: [{ idx: 0, version: "7", when: 1700000000001, tag: "0000_scs", breakpoints: true }] }));
    const avant = process.env["PGOPTIONS"];
    process.env["PGOPTIONS"] = "-c standard_conforming_strings=off";
    try {
      await migrer({ url: urlDe("console_migration", DIRECT()), dossier, journal: { schema: "essai_a233", table: "__migrations" } });
    } finally {
      if (avant === undefined) delete process.env["PGOPTIONS"];
      else process.env["PGOPTIONS"] = avant;
      const nettoyage = new pg.Client({ connectionString: urlDe("console_migration", DIRECT()) });
      await nettoyage.connect();
      await nettoyage.query("DROP TABLE IF EXISTS public.essai_scs_a233; DROP SCHEMA IF EXISTS essai_a233 CASCADE").catch(() => undefined);
      await nettoyage.end();
    }
  });

  it("[A-233] B9 : migrer refuse UPDATE pg_settings (client_encoding GBK) avant toute connexion", async () => {
    const dossier = mkdtempSync(join(tmpdir(), "migrer-"));
    mkdirSync(join(dossier, "meta"));
    writeFileSync(join(dossier, "0000_enc.sql"), "UPDATE pg_settings SET setting = 'GBK' WHERE name = 'client_encoding';\n--> statement-breakpoint\nSELECT E'\u20ac\\'; DROP TABLE essai_enc_a233; --';\n");
    writeFileSync(join(dossier, "meta/_journal.json"), JSON.stringify({ version: "7", dialect: "postgresql", entries: [{ idx: 0, version: "7", when: 1700000000002, tag: "0000_enc", breakpoints: true }] }));
    await expect(migrer({ url: urlDe("console_migration", DIRECT()), dossier })).rejects.toThrow(/pg_settings/);
  });

  it("[A-189] le journal des migrations est public.__migrations", async () => {
    const when = 1700000000100;
    const dossier = dossierEssai(when);
    await migrer({ url: urlDe("console_migration", DIRECT()), dossier });
    const lecture = new pg.Client({ connectionString: urlDe("console_migration", DIRECT()) });
    await lecture.connect();
    try {
      const journal = await lecture.query("SELECT count(*)::int AS n FROM public.__migrations WHERE created_at = $1", [when]);
      expect(journal.rows[0]?.["n"]).toBe(1);
      // Rien dans le journal par défaut de drizzle : les invariants C5 n'exemptent que public.__migrations.
      const ancien = await lecture.query("SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations WHERE created_at = $1", [when]).catch(() => ({ rows: [{ n: 0 }] }));
      expect(ancien.rows[0]?.["n"]).toBe(0);
    } finally {
      // On retire seulement la ligne d'essai : le journal réel reste en place.
      await lecture.query("DELETE FROM public.__migrations WHERE created_at = $1", [when]).catch(() => undefined);
      await lecture.query("DROP TABLE IF EXISTS public.essai_migration_a189").catch(() => undefined);
      await lecture.end();
    }
  });

  it("[A-189] deux migrer() simultanés n'appliquent la migration qu'une fois", async () => {
    const dossier = dossierEssai(1700000000200);
    const journal = { schema: "essai_verrou_a189", table: "__migrations" };
    const lecture = new pg.Client({ connectionString: urlDe("console_migration", DIRECT()) });
    await lecture.connect();
    try {
      await lecture.query("DROP TABLE IF EXISTS public.essai_migration_a189; DROP SCHEMA IF EXISTS essai_verrou_a189 CASCADE");
      const resultats = await Promise.allSettled([1, 2, 3].map(() => migrer({ url: urlDe("console_migration", DIRECT()), dossier, journal })));
      expect(resultats.map((r) => (r.status === "rejected" ? String(r.reason) : "ok"))).toEqual(["ok", "ok", "ok"]);
      const n = await lecture.query("SELECT count(*)::int AS n FROM essai_verrou_a189.__migrations");
      expect(n.rows[0]?.["n"]).toBe(1);
    } finally {
      await lecture.query("DROP TABLE IF EXISTS public.essai_migration_a189; DROP SCHEMA IF EXISTS essai_verrou_a189 CASCADE").catch(() => undefined);
      await lecture.end();
    }
  });
});
