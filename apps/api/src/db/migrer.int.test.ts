import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { migrer, VERROU_MIGRATION } from "./migrer.js";

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

// Le rapport de la CI est un JSON hors du journal : un essai en échec est écrit par writeSync(2, …).
afterEach((contexte) => {
  if (contexte.task.result?.state === "fail") writeSync(2, `ECHEC ${contexte.task.name} : ${String(contexte.task.result.errors?.[0]?.message ?? "").slice(0, 400)}\n`);
});

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
    // Depuis T2-01a, public.__migrations porte les vraies migrations : un essai ne peut plus y écrire une date de 2023 (drizzle la sauterait, migrer() la refuse).
    // On applique donc le vrai dossier et on lit le journal : une ligne par migration, et rien dans le journal par défaut de drizzle.
    const dossier = fileURLToPath(new URL("../../drizzle", import.meta.url));
    await migrer({ url: urlDe("console_migration", DIRECT()), dossier });
    const attendu = (JSON.parse(readFileSync(`${dossier}/meta/_journal.json`, "utf8")) as { entries: unknown[] }).entries.length;
    const lecture = new pg.Client({ connectionString: urlDe("console_migration", DIRECT()) });
    await lecture.connect();
    try {
      const journal = await lecture.query("SELECT count(*)::int AS n FROM public.__migrations");
      expect(journal.rows[0]?.["n"]).toBe(attendu);
      // Les invariants C5 n'exemptent que public.__migrations : le journal par défaut de drizzle ne doit pas exister.
      const ancien = await lecture.query("SELECT to_regclass('drizzle.__drizzle_migrations')::text AS t");
      expect(ancien.rows[0]?.["t"]).toBeNull();
    } finally {
      await lecture.end();
    }
  });

  it("[A-189] trois migrer() simultanés attendent le verrou puis n'appliquent la migration qu'une fois", async () => {
    const dossier = dossierEssai(1700000000200);
    const journal = { schema: "essai_verrou_a189", table: "__migrations" };
    const lecture = new pg.Client({ connectionString: urlDe("console_migration", DIRECT()) });
    const retenue = new pg.Client({ connectionString: urlDe("console_migration", DIRECT()) });
    await lecture.connect();
    await retenue.connect();
    try {
      await lecture.query("DROP TABLE IF EXISTS public.essai_migration_a189; DROP SCHEMA IF EXISTS essai_verrou_a189 CASCADE");
      // Course déterministe : l'essai tient le verrou, les trois migrer() démarrent et doivent TOUS attendre (pg_locks, granted = false).
      await retenue.query("SELECT pg_advisory_lock($1)", [VERROU_MIGRATION.toString()]);
      const enCours = [1, 2, 3].map(() => migrer({ url: urlDe("console_migration", DIRECT()), dossier, journal }));
      let attente = 0;
      for (let k = 0; k < 100 && attente < 3; k++) {
        const { rows } = await lecture.query("SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted");
        attente = rows[0]?.["n"] as number;
        if (attente < 3) await new Promise((r) => setTimeout(r, 100));
      }
      // Sans le verrou dans migrer(), personne n'attend.
      expect(attente).toBeGreaterThanOrEqual(3);
      expect((await lecture.query("SELECT to_regclass('essai_verrou_a189.__migrations')::text AS t")).rows[0]?.["t"]).toBeNull();
      await retenue.query("SELECT pg_advisory_unlock($1)", [VERROU_MIGRATION.toString()]);
      const resultats = await Promise.allSettled(enCours);
      expect(resultats.map((r) => (r.status === "rejected" ? String(r.reason) : "ok"))).toEqual(["ok", "ok", "ok"]);
      const n = await lecture.query("SELECT count(*)::int AS n FROM essai_verrou_a189.__migrations");
      expect(n.rows[0]?.["n"]).toBe(1);
    } finally {
      await retenue.end().catch(() => undefined);
      await lecture.query("DROP TABLE IF EXISTS public.essai_migration_a189; DROP SCHEMA IF EXISTS essai_verrou_a189 CASCADE").catch(() => undefined);
      await lecture.end();
    }
  });

  it("[A-189] une migration insérée au milieu du journal, sous la date de la dernière appliquée, est refusée au lieu d'être sautée", async () => {
    const racine = mkdtempSync(join(tmpdir(), "migrer-"));
    const ecrire = (nom: string, entrees: [string, number, string][]) => {
      const dossier = join(racine, nom);
      mkdirSync(join(dossier, "meta"), { recursive: true });
      for (const [tag, , sql] of entrees) writeFileSync(join(dossier, `${tag}.sql`), sql);
      writeFileSync(join(dossier, "meta/_journal.json"), JSON.stringify({ version: "7", dialect: "postgresql", entries: entrees.map(([tag, when], idx) => ({ idx, version: "7", when, tag, breakpoints: true })) }));
      return dossier;
    };
    const x: [string, number, string] = ["0000_x", 1700000000300, "CREATE TABLE essai_milieu_x_a189 (id integer);\n"];
    const a: [string, number, string] = ["0002_a", 1700000000500, "CREATE TABLE essai_milieu_a_a189 (id integer);\n"];
    const b: [string, number, string] = ["0001_b", 1700000000400, "CREATE TABLE essai_milieu_b_a189 (id integer);\n"];
    const journal = { schema: "essai_milieu_a189", table: "__migrations" };
    const url = urlDe("console_migration", DIRECT());
    const lecture = new pg.Client({ connectionString: url });
    await lecture.connect();
    try {
      await migrer({ url, dossier: ecrire("avant", [x, a]), journal });
      await expect(migrer({ url, dossier: ecrire("apres", [x, b, a]), journal })).rejects.toThrow(/0001_b/);
      expect((await lecture.query("SELECT to_regclass('public.essai_milieu_b_a189')::text AS t")).rows[0]?.["t"]).toBeNull();
    } finally {
      await lecture.query("DROP TABLE IF EXISTS public.essai_milieu_x_a189, public.essai_milieu_a_a189, public.essai_milieu_b_a189; DROP SCHEMA IF EXISTS essai_milieu_a189 CASCADE").catch(() => undefined);
      await lecture.end();
    }
  });

  // Échec fermé de 0019 (T2-52a) : base jetable migrée jusqu'à 0018, donnée fautive posée, puis 0019 doit échouer sans rien modifier.
  describe("échec fermé de la migration 0019", { timeout: 180_000 }, () => {
    const dossierComplet = fileURLToPath(new URL("../../drizzle", import.meta.url));
    const urlDe_ = (role: string, base: string) => `postgres://${role}:${motDePasseDe(role)}@${DIRECT()}/${base}`;
    // Base jetable : créée et peuplée par le superutilisateur (seul à pouvoir créer une base et à écrire hors RLS), avec la même mise en place que
    // ops/socle/postgres/init/03-console.sql ; migrée jusqu'à 0018 par console_migration ; la donnée fautive est posée hors RLS ; puis 0019 doit échouer.
    async function avecBaseJetable(poser: (c: pg.Client) => Promise<void>, verifier: (c: pg.Client) => Promise<void>): Promise<void> {
      const base = `essai_0019_${Math.random().toString(36).slice(2, 10)}`;
      const admin = new pg.Client({ connectionString: urlDe_("postgres", "console") });
      await admin.connect();
      const copie = mkdtempSync(join(tmpdir(), "migrer-0019-"));
      cpSync(dossierComplet, copie, { recursive: true });
      const journal = JSON.parse(readFileSync(join(copie, "meta/_journal.json"), "utf8")) as { entries: { tag: string }[] };
      const complet = JSON.stringify(journal);
      journal.entries = journal.entries.filter((e) => e.tag < "0019");
      writeFileSync(join(copie, "meta/_journal.json"), JSON.stringify(journal));
      let c: pg.Client | undefined;
      try {
        await admin.query(`CREATE DATABASE ${base} OWNER console_proprietaire`);
        c = new pg.Client({ connectionString: urlDe_("postgres", base) });
        await c.connect();
        await c.query(`ALTER SCHEMA public OWNER TO console_proprietaire; REVOKE ALL ON SCHEMA public FROM PUBLIC; GRANT USAGE ON SCHEMA public TO console_app, console_equipe;
          CREATE SCHEMA partman AUTHORIZATION console_proprietaire; CREATE EXTENSION pg_partman SCHEMA partman;
          GRANT ALL ON ALL TABLES IN SCHEMA partman TO console_proprietaire; GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA partman TO console_proprietaire; GRANT EXECUTE ON ALL PROCEDURES IN SCHEMA partman TO console_proprietaire;
          ALTER DEFAULT PRIVILEGES FOR ROLE console_proprietaire REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC; ALTER DEFAULT PRIVILEGES FOR ROLE console_migration REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC`);
        await migrer({ url: urlDe_("console_migration", base), dossier: copie });
        await poser(c);
        writeFileSync(join(copie, "meta/_journal.json"), complet);
        await expect(migrer({ url: urlDe_("console_migration", base), dossier: copie })).rejects.toThrow();
        await verifier(c);
      } finally {
        await c?.end().catch(() => undefined);
        await admin.query(`DROP DATABASE IF EXISTS ${base} WITH (FORCE)`).catch(() => undefined);
        await admin.end();
      }
    }
    const ORG = "INSERT INTO organisations (id, tenant_id, console_client_id, raison_sociale) VALUES ($1, $1, $1, 'Atelier Bertin')";
    const INST = "INSERT INTO instances (id, tenant_id, organisation_id, code_automatisation, formule, environnement, etat) VALUES ($1, $2, $2, 'relance-devis', 'abonnement', 'test', 'pause')";

    it("[A-233] une base qui contient déjà un doublon d'instances.id fait échouer 0019 sans ligne modifiée ni supprimée", async () => {
      const [A, B, id] = [randomUUID(), randomUUID(), randomUUID()];
      await avecBaseJetable(
        async (c) => {
          await c.query("SELECT set_config('app.acteur', 'agent-essai', false)");
          for (const t of [A, B]) {
            await c.query("SELECT set_config('app.tenant_id', $1, false)", [t]);
            await c.query(ORG, [t]);
            await c.query(INST, [id, t]);
          }
        },
        async (c) => {
          expect((await c.query("SELECT count(*)::int AS n FROM instances")).rows[0]?.["n"]).toBe(2);
          expect((await c.query("SELECT to_regclass('public.instances_id_unique')::text AS t")).rows[0]?.["t"]).toBeNull();
          expect((await c.query("SELECT column_default FROM information_schema.columns WHERE table_name = 'instances' AND column_name = 'id'")).rows[0]?.["column_default"]).toBeNull();
          expect((await c.query("SELECT count(*)::int AS n FROM public.__migrations")).rows[0]?.["n"]).toBe(15);
        },
      );
    });

    it("[A-233] un code de cellule ab_cd existant fait échouer 0019", async () => {
      await avecBaseJetable(
        async (c) => {
          await c.query("SELECT set_config('app.acteur', 'agent-essai', false)");
          await c.query("INSERT INTO cellules (code, adresse_interne, mode, capacite, nombre_instances, version_image, etat) VALUES ('ab_cd', 'ab-cd.interne.test', 'mutualise', 50, 0, '1.0.0', 'active')");
        },
        async (c) => {
          expect((await c.query("SELECT count(*)::int AS n FROM cellules WHERE code = 'ab_cd'")).rows[0]?.["n"]).toBe(1);
          expect((await c.query("SELECT count(*)::int AS n FROM pg_constraint WHERE conname = 'cellules_code_forme_c4'")).rows[0]?.["n"]).toBe(0);
        },
      );
    });
  });
});
