import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrer } from "../db/migrer.js";
import { creerJournalAuditBase } from "./base.js";

// Port JournalAudit contre le vrai PostgreSQL (job socle-integration), même méthode de connexion que db/audit.int.test.ts.
const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8" }).trim();
const conteneur = (service: string) =>
  docker("ps", "-q", "--filter", "label=com.docker.compose.project=socle", "--filter", `label=com.docker.compose.service=${service}`);
function cible(service: string, port: number, surcharge: string | undefined): { host: string; port: number } {
  if (surcharge) return { host: surcharge.split(":")[0] ?? "", port: Number(surcharge.split(":")[1]) };
  return { host: docker("inspect", "-f", '{{(index .NetworkSettings.Networks "socle_interne").IPAddress}}', conteneur(service)), port };
}
function secret(): string {
  if (process.env["SOCLE_PG_MOT_DE_PASSE"]) return process.env["SOCLE_PG_MOT_DE_PASSE"];
  const ligne = docker("inspect", "-f", "{{range .Config.Env}}{{println .}}{{end}}", conteneur("postgres")).split("\n").find((l) => l.startsWith("SOCLE_PG_MOT_DE_PASSE="));
  if (!ligne) throw new Error("mot de passe de test introuvable");
  return ligne.slice("SOCLE_PG_MOT_DE_PASSE=".length);
}
const SECRET = secret();
const DIRECT = cible("postgres", 5432, process.env["SOCLE_PG_DIRECT"]);
const PGBOUNCER = cible("pgbouncer", 6432, process.env["SOCLE_PG_PGBOUNCER"]);
const motDePasseDe = (role: string) => createHash("sha256").update(`${SECRET}/${role}`).digest("hex");
const ouvrir = (voie: { host: string; port: number }, user: string, max: number) => {
  const p = new pg.Pool({ ...voie, user, database: "console", password: motDePasseDe(user), max, connectionTimeoutMillis: 10_000 });
  p.on("error", () => undefined);
  return p;
};
const migration = ouvrir(DIRECT, "console_migration", 2);
const app = ouvrir(PGBOUNCER, "console_app", 4);

beforeAll(async () => {
  await migrer({ url: `postgres://console_migration:${motDePasseDe("console_migration")}@${DIRECT.host}:${DIRECT.port}/console`, dossier: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
}, 120_000);
afterAll(async () => {
  await Promise.all([migration.end(), app.end()].map((p) => p.catch(() => undefined)));
});

describe("journal d'audit en base", { timeout: 30_000 }, () => {
  it("[A-131] le port JournalAudit écrit dans la base hors tests unitaires", async () => {
    const journal = creerJournalAuditBase(app);
    const A = randomUUID();
    const motif = `essai-${randomUUID()}`;
    await journal.ecrire({ action: "blocage_cle", tenantId: A, parQui: "systeme", motif, montantConsommeMicroCentimes: 1234 });
    // Sans client (plafond du jour) et sans montant lu : ligne d'équipe, la clé « montant » est absente.
    const motifEquipe = `essai-${randomUUID()}`;
    await journal.ecrire({ action: "levee_budget_jour", parQui: "admin-essai", motif: motifEquipe });
    const avec = await migration.query("SELECT tenant_id, acteur, action::text AS action, entite, nouvelle FROM public.journal_audit WHERE nouvelle->>'motif' = $1", [motif]);
    expect(avec.rows).toHaveLength(1);
    expect(avec.rows[0]).toMatchObject({ tenant_id: A, acteur: "systeme", action: "blocage_cle", nouvelle: { motif, montant_consomme_micro_centimes: 1234 } });
    const equipe = await migration.query("SELECT tenant_id, acteur, action::text AS action, nouvelle FROM public.journal_audit WHERE nouvelle->>'motif' = $1", [motifEquipe]);
    expect(equipe.rows).toHaveLength(1);
    expect(equipe.rows[0]).toMatchObject({ tenant_id: null, acteur: "admin-essai", action: "levee_budget_jour" });
    expect(equipe.rows[0]?.["nouvelle"]).not.toHaveProperty("montant_consomme_micro_centimes");
  });

  it("[A-131] un montant qui n'est pas un entier est refusé, rien n'est écrit", async () => {
    const motif = `essai-${randomUUID()}`;
    await expect(creerJournalAuditBase(app).ecrire({ action: "blocage_cle", tenantId: randomUUID(), parQui: "systeme", motif, montantConsommeMicroCentimes: 12.5 })).rejects.toThrow(/entier/);
    const { rows } = await migration.query("SELECT count(*)::int AS n FROM public.journal_audit WHERE nouvelle->>'motif' = $1", [motif]);
    expect(rows[0]?.["n"]).toBe(0);
  });
});
