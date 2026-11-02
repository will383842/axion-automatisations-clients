import { execFileSync } from "node:child_process";
import { writeSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { avecClient } from "../db/client-actif.js";
import { migrer } from "../db/migrer.js";
import { balayer } from "./balayage-c2.js";
import { depotPg } from "./depot-pg.js";
import { NOM_TACHE, recevoirFait, type FaitRange } from "./recepteur-c2.js";

// Adaptateur Postgres du récepteur C2 (T2-16b) sur la vraie base. Socle lancé par ops/socle/lancer.sh (job socle-integration).
const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8" }).trim();
const conteneur = (service: string) => docker("ps", "-q", "--filter", "label=com.docker.compose.project=socle", "--filter", `label=com.docker.compose.service=${service}`);
function cible(service: string, port: number, surcharge: string | undefined): { host: string; port: number } {
  if (surcharge) return { host: surcharge.split(":")[0] ?? "", port: Number(surcharge.split(":")[1]) };
  const modele = '{{(index .NetworkSettings.Networks "socle_interne").IPAddress}}';
  return { host: docker("inspect", "-f", modele, conteneur(service)), port };
}
function secret(): string {
  if (process.env["SOCLE_PG_MOT_DE_PASSE"]) return process.env["SOCLE_PG_MOT_DE_PASSE"];
  const variables = docker("inspect", "-f", "{{range .Config.Env}}{{println .}}{{end}}", conteneur("postgres")).split("\n");
  const ligne = variables.find((l) => l.startsWith("SOCLE_PG_MOT_DE_PASSE="));
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
const app = pool(PGBOUNCER, "console_app", 20);
const equipe = pool(PGBOUNCER, "console_equipe", 3);
const APPELANT = { acteur: "agent-essai", ip: "192.0.2.17" };
const creerOrg = (id: string) => avecClient(app, id, (c) => c.query("INSERT INTO organisations (tenant_id, id, console_client_id, raison_sociale) VALUES ($1, $1, $1, 'Garage Fontaine')", [id]), APPELANT);

beforeAll(async () => {
  await migrer({ url: `postgres://console_migration:${motDePasseDe("console_migration")}@${DIRECT.host}:${DIRECT.port}/console`, dossier: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
}, 120_000);
afterAll(async () => {
  await Promise.all(ouverts.map((o) => o.end().catch(() => undefined)));
});

const fait = (sequence: number, extra: Partial<FaitRange> = {}): FaitRange => ({ eventId: randomUUID(), type: "paiement.recu", sequence, sujet: "AXI-CLI-000001", payload: { numeroFacture: "AXI-FACT-000001", montantCentimes: 100 }, ...extra });
const enveloppe = (client: string, f: FaitRange) => ({
  event_id: f.eventId, schema_version: 1, occurred_at: "2026-10-24T10:00:00Z", emitted_at: "2026-10-24T10:00:01Z", producer: "axion-ia-hub",
  subject_ref: { axiCli: f.sujet, consoleClientId: client }, sequence: f.sequence, event_type: f.type,
  payload: { numeroFacture: "AXI-FACT-000001", montantCentimes: 100, dateReception: "2026-10-24", moyen: "virement" },
});

// BILAN affiché dans le journal de la CI : le rapport JSON de l'intégration n'est pas publié, un échec n'y serait pas lisible.
const essai = (nom: string, fn: () => Promise<void>) =>
  it(nom, async ({ onTestFailed }) => {
    onTestFailed((resultat) => void writeSync(2, `BILAN depot-pg : ROUGE ${nom.slice(0, 60)} : ${String((resultat as unknown as { errors?: { message?: string }[] }).errors?.[0]?.message).slice(0, 400)}\n`));
    await fn();
    writeSync(2, `BILAN depot-pg : vert ${nom.slice(0, 60)}\n`);
  });

describe("adaptateur Postgres du récepteur C2", { timeout: 30_000 }, () => {
  essai("[C-338] [T2-16b] @anti-doublon un fait rangé deux fois en parallèle n'existe qu'une fois ; le contenu allégé est celui de la première réception", async () => {
    const client = randomUUID();
    await creerOrg(client);
    const depot = depotPg(app, equipe);
    const f = fait(0);
    const [a, b] = await Promise.all([depot.ranger(client, f, Date.now()), depot.ranger(client, { ...f, payload: { numeroFacture: "AUTRE" } }, Date.now())]);
    expect([a.neuf, b.neuf].sort()).toEqual([false, true]);
    expect(JSON.stringify([a.payload, b.payload])).not.toContain("AUTRE");
    expect(await avecClient(app, client, async (c) => (await c.query("SELECT count(*)::int AS n FROM faits_recus WHERE tenant_id = $1", [client])).rows[0]?.["n"])).toBe(1);
    expect(await depot.organisationExiste(client)).toBe(true);
    expect(await depot.organisationExiste(randomUUID())).toBe(false);
  });

  essai("[C-338] [T2-16b] Valkey perdu après le 200 : le balayage remet le fait en file depuis la base, avec son contenu", async () => {
    const client = randomUUID();
    await creerOrg(client);
    const depot = depotPg(app, equipe);
    const taches: { nom: string; donnees: { payload?: unknown }; jobId?: string }[] = [];
    // La base est partagée avec d'autres essais en parallèle : le balayage est limité au sujet de cet essai (les autres sujets seraient longs à parcourir).
    const f = fait(0);
    const seul = { ...depot, sujetsEnAttente: async () => [{ tenantId: client, sujet: f.sujet }] };
    const deps = {
      depot: seul,
      file: { name: "faits-c2", async add(nom: string, donnees: unknown, o?: { jobId?: string }) { taches.push({ nom, donnees: donnees as never, ...(o?.jobId ? { jobId: o.jobId } : {}) }); } },
      rattrapage: { async demander() {} },
      alerter: () => undefined,
      maintenant: () => Date.now(),
    };
    await recevoirFait(deps, enveloppe(client, f));
    taches.length = 0;
    const r = await balayer(deps, Date.now() + 10 * 60_000, 500);
    expect(r.remis).toBe(1);
    // La liste réelle des sujets à balayer (sans limite pratique) contient ce sujet.
    expect(await depot.sujetsEnAttente(1_000_000)).toContainEqual({ tenantId: client, sujet: f.sujet });
    const mienne = taches.find((t) => (t.donnees as { eventId?: string }).eventId === f.eventId);
    expect(mienne?.nom).toBe(NOM_TACHE);
    expect(JSON.stringify(mienne?.donnees)).toContain("AXI-FACT-000001");
    // Une fois traité, le fait n'est plus remis en file.
    await avecClient(app, client, (c) => c.query("UPDATE faits_recus SET traite_le = now(), resultat = 'traite' WHERE tenant_id = $1", [client]), APPELANT);
    taches.length = 0;
    await balayer(deps, Date.now() + 20 * 60_000, 500);
    expect(taches.find((t) => (t.donnees as { eventId?: string }).eventId === f.eventId)).toBeUndefined();
  });

  essai("[C-338] [T2-16b] @isolation un client ne lit pas les faits d'un autre ; aucun DELETE ; le contenu rangé ne se modifie pas", async () => {
    const a = randomUUID();
    const b = randomUUID();
    await creerOrg(a);
    await creerOrg(b);
    await depotPg(app, equipe).ranger(a, fait(0), Date.now());
    expect(await avecClient(app, b, async (c) => (await c.query("SELECT count(*)::int AS n FROM faits_recus WHERE tenant_id = $1", [a])).rows[0]?.["n"])).toBe(0);
    await expect(avecClient(app, a, (c) => c.query("DELETE FROM faits_recus WHERE tenant_id = $1", [a]), APPELANT)).rejects.toThrow(/permission|denied|refus/i);
    await expect(avecClient(app, a, (c) => c.query("UPDATE faits_recus SET payload = '{}'::jsonb WHERE tenant_id = $1", [a]), APPELANT)).rejects.toThrow(/permission|denied|refus/i);
  });

  essai("[C-338] [T2-16b] @isolation un INSERT fait sous le client B avec tenant_id = A est refusé par le WITH CHECK de la RLS", async () => {
    const a = randomUUID();
    const b = randomUUID();
    await creerOrg(a);
    await creerOrg(b);
    await expect(
      avecClient(
        app,
        b,
        (c) => c.query("INSERT INTO faits_recus (tenant_id, id, source, event_id, type, sequence, sujet, recu_le, payload) VALUES ($1, gen_random_uuid(), 'hub', $2, 'paiement.recu', 0, 'AXI-CLI-000001', now(), '{}'::jsonb)", [a, randomUUID()]),
        APPELANT,
      ),
    ).rejects.toThrow(/row-level security|row level security|politique|policy/i);
    expect(await avecClient(app, a, async (c) => (await c.query("SELECT count(*)::int AS n FROM faits_recus WHERE tenant_id = $1", [a])).rows[0]?.["n"])).toBe(0);
  });
});
