import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { avecClient } from "../../db/client-actif.js";
import { migrer } from "../../db/migrer.js";
import { journalEchecs } from "../../provisionnement/journal-echecs.js";
import { creerDepotConnexions } from "./depot.js";

// Essai réel du dépôt des connexions : socle lancé par ops/socle/lancer.sh (job socle-integration), sous console_app puis console_equipe.
// Aucun Docker en cloud : ce fichier n'est joué que par la CI ou sur une base locale (variables SOCLE_PG_*). Échecs écrits par writeSync(2, …), sans secret.
journalEchecs(import.meta.url);
const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8" }).trim();
const conteneur = (service: string) => docker("ps", "-q", "--filter", "label=com.docker.compose.project=socle", "--filter", `label=com.docker.compose.service=${service}`);
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
const ouverts: { end(): Promise<void> }[] = [];
function pool(voie: { host: string; port: number }, user: string, max: number): pg.Pool {
  const p = new pg.Pool({ ...voie, user, database: "console", password: motDePasseDe(user), max, connectionTimeoutMillis: 10_000 });
  p.on("error", () => undefined);
  ouverts.push(p);
  return p;
}
const app = pool(PGBOUNCER, "console_app", 10);
const equipe = pool(PGBOUNCER, "console_equipe", 3);
const depot = creerDepotConnexions(app);
const APPELANT = { acteur: "agent-essai", ip: "192.0.2.17" };

beforeAll(async () => {
  await migrer({ url: `postgres://console_migration:${motDePasseDe("console_migration")}@${DIRECT.host}:${DIRECT.port}/console`, dossier: fileURLToPath(new URL("../../../drizzle", import.meta.url)) });
}, 120_000);
afterAll(async () => { await Promise.all(ouverts.map((o) => o.end().catch(() => undefined))); });

const creerOrg = (A: string) => avecClient(app, A, (c) => c.query("INSERT INTO organisations (id, tenant_id, console_client_id, raison_sociale) VALUES ($1, $1, $1, 'Lemoine Rénovation')", [A]), APPELANT);
async function connexion(A: string): Promise<string> {
  const id = randomUUID();
  await depot.creer({ tenantId: A, acteur: APPELANT.acteur, connexionId: id, organisationId: A, outil: "microsoft-365", connecteur: "microsoft-graph", portee: "lecture", referenceCoffre: `bao:clients/${A}/connexions/${id}/jetons` });
  return id;
}
const etatDe = async (A: string, id: string) => (await equipe.query("SELECT etat, dernier_test_le FROM connexions WHERE tenant_id = $1 AND id = $2", [A, id])).rows[0] as { etat: string; dernier_test_le: Date | null };

describe("dépôt des connexions sur la base réelle", () => {
  it("[B-092] réclamation en base : deux transactions concurrentes, une seule ligne passe", async () => {
    const A = randomUUID();
    await creerOrg(A);
    const id = await connexion(A);
    const resultats = await Promise.all(Array.from({ length: 6 }, () => depot.reclamer(A, id, APPELANT.acteur)));
    expect(resultats.filter(Boolean)).toHaveLength(1);
    expect((await etatDe(A, id)).dernier_test_le).not.toBeNull();
    // Une connexion réclamée ne se réclame plus ; une fois testée, elle sort de a_tester.
    expect(await depot.reclamer(A, id, APPELANT.acteur)).toBe(false);
    await depot.marquerEtat(A, id, APPELANT.acteur, "active");
    expect((await etatDe(A, id)).etat).toBe("active");
    expect(await depot.reclamer(A, id, APPELANT.acteur)).toBe(false);
  });

  it("[A-393] révocation en base : définitive, acteur dans journal_audit, instances liées en pause, aucune autre table touchée", async () => {
    const A = randomUUID();
    await creerOrg(A);
    const id = await connexion(A);
    // Une instance ne s'active qu'avec un contrat de sous-traitance signé (C-030) : contrat d'essai, puis deux instances créées en pause et activées.
    await avecClient(app, A, (c) => c.query("INSERT INTO contrats (tenant_id, id, organisation_id, type, date_signature, pdf_ref, empreinte_sha256, auteur) VALUES ($1, gen_random_uuid(), $1, 'sous_traitance_art28', '2026-01-15', $2, $3, $4)", [A, `contrats/${A}/art28.pdf`, "a".repeat(64), APPELANT.acteur]), APPELANT);
    const creerActive = (): Promise<string> => avecClient(app, A, async (c) => {
      const id = (await c.query("INSERT INTO instances (tenant_id, organisation_id, code_automatisation, formule, environnement, etat) VALUES ($1, $1, 'relance-devis', 'abonnement', 'production', 'pause') RETURNING id", [A])).rows[0]?.["id"] as string;
      await c.query("UPDATE instances SET etat = 'active' WHERE id = $1", [id]);
      return id;
    }, APPELANT);
    const instance = await creerActive();
    const autre = await creerActive();
    await avecClient(app, A, (c) => c.query("INSERT INTO connexions_instances (tenant_id, id, connexion_id, instance_id) VALUES ($1, gen_random_uuid(), $2, $3)", [A, id, instance]), APPELANT);
    const avant = Number((await equipe.query("SELECT count(*) AS n FROM organisations WHERE tenant_id = $1", [A])).rows[0]?.["n"]);

    expect(await depot.existe(A, id)).toBe(true);
    expect(await depot.marquerRevoquee(A, id, "will383842", "decision_dirigeant")).toBe(true);
    expect(await depot.mettreEnPause(A, id, "will383842")).toBe(1);
    expect((await etatDe(A, id)).etat).toBe("revoquee");
    expect((await equipe.query("SELECT id, etat FROM instances WHERE tenant_id = $1 ORDER BY etat", [A])).rows).toEqual(expect.arrayContaining([{ id: instance, etat: "pause" }, { id: autre, etat: "active" }]));
    // Définitive : une seconde révocation ne touche rien, et la base refuse toute autre modification.
    expect(await depot.marquerRevoquee(A, id, "will383842", "decision_dirigeant")).toBe(false);
    await expect(avecClient(app, A, (c) => c.query("UPDATE connexions SET etat = 'active' WHERE tenant_id = $1 AND id = $2", [A, id]), APPELANT).then((r) => { if (r.rowCount === 0) throw new Error("0 ligne"); })).rejects.toThrow();
    expect((await etatDe(A, id)).etat).toBe("revoquee");
    const trace = await equipe.query("SELECT acteur FROM journal_audit WHERE tenant_id = $1 AND entite = 'connexions' AND nouvelle->>'etat' = 'revoquee'", [A]);
    expect(trace.rows.map((r) => r["acteur"])).toContain("will383842");
    expect(Number((await equipe.query("SELECT count(*) AS n FROM organisations WHERE tenant_id = $1", [A])).rows[0]?.["n"])).toBe(avant);
    expect(Number((await equipe.query("SELECT count(*) AS n FROM connexions_instances WHERE tenant_id = $1 AND delie_le IS NULL", [A])).rows[0]?.["n"])).toBe(1);
  });

  it("[A-393] révocation sans app.acteur : refusée par la base", async () => {
    const A = randomUUID();
    await creerOrg(A);
    const id = await connexion(A);
    // Même requête que le dépôt, mais sans appelant : app.acteur n'est pas posé.
    const sansActeur = await avecClient(app, A, (c) => c.query("UPDATE connexions SET etat = 'revoquee' WHERE tenant_id = $1 AND id = $2", [A, id])).then(() => "accepte", (e: { code?: string }) => e.code ?? "refuse");
    expect(sansActeur).toBe("42501");
    expect((await etatDe(A, id)).etat).toBe("a_tester");
  });

  it("[A-393] le client A ne révoque pas une connexion du client B (RLS : 0 ligne, inconnue)", async () => {
    const A = randomUUID(), B = randomUUID();
    await creerOrg(A);
    await creerOrg(B);
    const idB = await connexion(B);
    expect(await depot.existe(A, idB)).toBe(false);
    expect(await depot.marquerRevoquee(A, idB, "will383842", "decision_dirigeant")).toBe(false);
    expect(await depot.reclamer(A, idB, "will383842")).toBe(false);
    expect((await etatDe(B, idB)).etat).toBe("a_tester");
  });
});
