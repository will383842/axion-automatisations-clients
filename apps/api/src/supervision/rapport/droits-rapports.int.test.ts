import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { avecClient } from "../../db/client-actif.js";
import { migrer } from "../../db/migrer.js";
import { journalEchecs } from "../../provisionnement/journal-echecs.js";

// T5-22a (ADR 0141) : droits d'écriture de rapports_mensuels pour console_app. Socle lancé par ops/socle/lancer.sh (job socle-integration).
// Aucune valeur secrète n'est écrite : les échecs passent par journalEchecs (writeSync(2, …)).
journalEchecs(import.meta.url);
const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8" }).trim();
const conteneur = (service: string) => docker("ps", "-q", "--filter", "label=com.docker.compose.project=socle", "--filter", `label=com.docker.compose.service=${service}`);
function cible(service: string, port: number, surcharge: string | undefined): { host: string; port: number } {
  if (surcharge) return { host: surcharge.split(":")[0] ?? "", port: Number(surcharge.split(":")[1]) };
  const modele = '{{(index .NetworkSettings.Networks "socle_interne").IPAddress}}';
  return { host: docker("inspect", "-f", modele, conteneur(service)), port };
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
const ouverts: { end(): Promise<void> }[] = [];
const pool = (voie: { host: string; port: number }, user: string, max: number): pg.Pool => {
  const p = new pg.Pool({ ...voie, user, database: "console", password: motDePasseDe(user), max, connectionTimeoutMillis: 10_000 });
  p.on("error", () => undefined);
  ouverts.push(p);
  return p;
};
const app = pool(PGBOUNCER, "console_app", 10);
const equipe = pool(PGBOUNCER, "console_equipe", 3);
const APPELANT = { acteur: "agent-essai", ip: "192.0.2.17" };
const MOIS = "2026-10-01";

async function ecrire<T>(...args: Parameters<typeof avecClient<T>>): Promise<T> {
  for (let essai = 1; ; essai++) {
    try {
      return await avecClient(...args);
    } catch (e) {
      if (!["55P03", "40P01"].includes((e as { code?: string }).code ?? "") || essai >= 6) throw e;
    }
  }
}
const creerOrg = (id: string) => ecrire(app, id, (c) => c.query("INSERT INTO organisations (id, tenant_id, console_client_id, raison_sociale) VALUES ($1, $1, $1, 'Boulangerie Rivoire')", [id]), APPELANT);
const preparer = (A: string, id = randomUUID(), mois = MOIS, acteur = APPELANT) =>
  ecrire(app, A, (c) => c.query("INSERT INTO rapports_mensuels (tenant_id, id, organisation_id, mois, objet_pdf_ref) VALUES ($1, $2, $1, $3, $4)", [A, id, mois, `rapports/2026-10/${id}.pdf`]), acteur);
const envoyer = (A: string, id: string, acteur = APPELANT) =>
  ecrire(app, A, (c) => c.query("UPDATE rapports_mensuels SET etat = 'envoye', envoye_par = current_setting('app.acteur'), envoye_le = now() WHERE id = $1", [id]), acteur);

beforeAll(async () => {
  await migrer({ url: `postgres://console_migration:${motDePasseDe("console_migration")}@${DIRECT.host}:${DIRECT.port}/console`, dossier: fileURLToPath(new URL("../../../drizzle", import.meta.url)) });
}, 120_000);
afterAll(async () => {
  await Promise.all(ouverts.map((o) => o.end().catch(() => undefined)));
});

describe("rapports mensuels : écriture par console_app", () => {
  it("[B-406] console_app prépare un rapport pour son client, à l'état prepare", async () => {
    const A = randomUUID();
    await creerOrg(A);
    const id = randomUUID();
    await preparer(A, id);
    const r = await ecrire(app, A, (c) => c.query("SELECT etat, envoye_par, envoye_le FROM rapports_mensuels WHERE id = $1", [id]));
    expect(r.rows[0]).toEqual({ etat: "prepare", envoye_par: null, envoye_le: null });
  });

  it("[B-406] @isolation console_app sous le client A ne peut pas préparer un rapport pour B", async () => {
    const A = randomUUID(), B = randomUUID();
    await creerOrg(A);
    await creerOrg(B);
    await expect(ecrire(app, A, (c) => c.query("INSERT INTO rapports_mensuels (tenant_id, id, organisation_id, mois, objet_pdf_ref) VALUES ($1, $2, $1, $3, 'rapports/x.pdf')", [B, randomUUID(), MOIS]), APPELANT)).rejects.toMatchObject({ code: "42501" });
  });

  it("[B-406] sans acteur, la préparation est refusée ; un rapport inséré déjà « envoye » est refusé (colonne sans droit)", async () => {
    const A = randomUUID();
    await creerOrg(A);
    await expect(ecrire(app, A, (c) => c.query("INSERT INTO rapports_mensuels (tenant_id, id, organisation_id, mois, objet_pdf_ref) VALUES ($1, $2, $1, $3, 'rapports/x.pdf')", [A, randomUUID(), MOIS]))).rejects.toMatchObject({ code: "42501" });
    await expect(ecrire(app, A, (c) => c.query("INSERT INTO rapports_mensuels (tenant_id, id, organisation_id, mois, objet_pdf_ref, etat) VALUES ($1, $2, $1, $3, 'rapports/x.pdf', 'envoye')", [A, randomUUID(), MOIS]), APPELANT)).rejects.toMatchObject({ code: "42501" });
  });

  it("[B-406] un second rapport pour le même mois est refusé par l'unicité (23505)", async () => {
    const A = randomUUID();
    await creerOrg(A);
    await preparer(A);
    await expect(preparer(A)).rejects.toMatchObject({ code: "23505" });
  });

  it("[B-407] l'envoi passe prepare → envoye une fois, par l'acteur, à l'heure de la transaction", async () => {
    const A = randomUUID();
    await creerOrg(A);
    const id = randomUUID();
    await preparer(A, id);
    await envoyer(A, id);
    const r = await ecrire(app, A, (c) => c.query("SELECT etat, envoye_par, envoye_le IS NOT NULL AS date FROM rapports_mensuels WHERE id = $1", [id]));
    expect(r.rows[0]).toEqual({ etat: "envoye", envoye_par: "agent-essai", date: true });
  });

  it("[B-407] un second envoi ne touche aucune ligne et un envoi sous un autre acteur que celui de la session est refusé", async () => {
    const A = randomUUID();
    await creerOrg(A);
    const id = randomUUID();
    await preparer(A, id);
    await envoyer(A, id);
    const encore = await ecrire(app, A, (c) => c.query("UPDATE rapports_mensuels SET etat = 'envoye', envoye_par = 'agent-essai', envoye_le = now() WHERE id = $1", [id]), APPELANT);
    expect(encore.rowCount).toBe(0);
    const B = randomUUID();
    await creerOrg(B);
    const idB = randomUUID();
    await preparer(B, idB);
    await expect(ecrire(app, B, (c) => c.query("UPDATE rapports_mensuels SET etat = 'envoye', envoye_par = 'usurpateur', envoye_le = now() WHERE id = $1", [idB]), APPELANT)).rejects.toMatchObject({ code: "42501" });
  });

  it("[B-407] objet_pdf_ref, mois et organisation_id ne se modifient jamais ; aucune suppression", async () => {
    const A = randomUUID();
    await creerOrg(A);
    const id = randomUUID();
    await preparer(A, id);
    for (const col of ["objet_pdf_ref = 'rapports/autre.pdf'", "mois = '2026-09-01'"]) {
      await expect(ecrire(app, A, (c) => c.query(`UPDATE rapports_mensuels SET ${col} WHERE id = $1`, [id]), APPELANT), col).rejects.toMatchObject({ code: "42501" });
    }
    await expect(ecrire(app, A, (c) => c.query("DELETE FROM rapports_mensuels WHERE id = $1", [id]), APPELANT)).rejects.toMatchObject({ code: "42501" });
  });

  it("[B-406] console_equipe ne peut toujours pas écrire dans rapports_mensuels", async () => {
    const c = await equipe.connect();
    try {
      await c.query("BEGIN");
      await expect(c.query("INSERT INTO rapports_mensuels (tenant_id, id, organisation_id, mois, objet_pdf_ref) VALUES (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), '2026-10-01', 'rapports/x.pdf')")).rejects.toMatchObject({ code: "42501" });
    } finally {
      await c.query("ROLLBACK").catch(() => undefined);
      c.release();
    }
  });
});
