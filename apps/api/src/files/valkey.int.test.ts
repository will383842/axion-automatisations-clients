import { execFileSync } from "node:child_process";
import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import { afterAll, describe, expect, it } from "vitest";
import { analyserInfo, ouvrirConnexion } from "./connexion.js";
import { creerFile, deposer, idTache, PREFIXE } from "./files.js";

// Tests contre le Valkey du socle lancé par ops/socle/lancer.sh (job socle-integration).
// Le réseau « interne » n'ouvre aucun port : depuis l'hôte Linux, on joint l'adresse du conteneur lue avec docker inspect.
const TENANT = "3f2b8c1e-5a4d-4e6f-9b7a-1c2d3e4f5a6b";

const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8" }).trim();
const conteneur = () => docker("ps", "-q", "--filter", "label=com.docker.compose.project=socle", "--filter", "label=com.docker.compose.service=valkey");
const attendre = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

function parametres() {
  const id = conteneur();
  const ip = docker("inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}", id).split(" ")[0] ?? "";
  const env = JSON.parse(docker("inspect", "-f", "{{json .Config.Env}}", id)) as string[];
  const motDePasse = env.find((e) => e.startsWith("VALKEY_MOT_DE_PASSE="))?.slice("VALKEY_MOT_DE_PASSE=".length) ?? "";
  return { host: ip, port: 6379, password: motDePasse };
}

async function attendreSante() {
  for (let i = 0; i < 60; i++) {
    try {
      if (docker("inspect", "-f", "{{.State.Health.Status}}", conteneur()) === "healthy") return;
    } catch {
      /* conteneur en cours de relance */
    }
    await attendre(1000);
  }
  throw new Error("Valkey n'est pas redevenu sain");
}

// Les files et les workers se ferment avant les connexions qu'ils utilisent.
const ouverts: { quit: () => Promise<unknown> | unknown }[] = [];
const connexions: { quit: () => Promise<unknown> | unknown }[] = [];
afterAll(async () => {
  for (const o of ouverts) await o.quit();
  for (const c of connexions) await c.quit();
});

describe("Valkey du socle", () => {
  it("[A-051] une tâche BullMQ est déposée puis traitée, et le serveur se déclare Valkey (INFO server)", async () => {
    const connexion = await ouvrirConnexion(parametres());
    connexions.push(connexion);
    expect(analyserInfo(await connexion.info("server")).get("server_name")).toBe("valkey");

    const file = creerFile("essai-traite", connexion.client);
    const traite = new Promise<string>((ok) => {
      const w = new Worker("essai-traite", (job) => Promise.resolve(ok(String(job.data.tenantId))), { connection: connexion.client.duplicate({ maxRetriesPerRequest: null }), prefix: PREFIXE });
      ouverts.push({ quit: () => w.close() });
    });
    await deposer(file, { tenantId: TENANT, type: "essai", cle: `traite-${Date.now()}` }, {});
    expect(await traite).toBe(TENANT);
    ouverts.push({ quit: () => file.close() });
  });

  it("[A-051] la connexion refuse de démarrer si maxmemory-policy n'est pas noeviction", async () => {
    const admin = new Redis(parametres());
    connexions.push(admin);
    await admin.config("SET", "maxmemory-policy", "allkeys-lru");
    try {
      await expect(ouvrirConnexion(parametres())).rejects.toThrow(/maxmemory-policy/);
    } finally {
      await admin.config("SET", "maxmemory-policy", "noeviction");
    }
    const bonne = await ouvrirConnexion(parametres());
    connexions.push(bonne);
  });

  it("[LOT1-files] @anti-doublon deux dépôts avec le même jobId donnent une seule tâche", async () => {
    const connexion = await ouvrirConnexion(parametres());
    connexions.push(connexion);
    const nom = `essai-doublon-${Date.now()}`;
    const file = creerFile(nom, connexion.client);
    ouverts.push({ quit: () => file.close() });
    const intention = { tenantId: TENANT, type: "relance", cle: "dossier-12" };
    await Promise.all([deposer(file, intention, { n: 1 }), deposer(file, intention, { n: 2 })]);
    await deposer(file, intention, { n: 3 });
    expect(await file.getJobCounts("wait", "active", "delayed", "completed")).toMatchObject({ wait: 1 });
    expect((await file.getJobs(["wait"])).length).toBe(1);
  });

  it("[A-191] @anti-doublon une tâche déposée survit à un redémarrage de Valkey (journal AOF)", async () => {
    const connexion = await ouvrirConnexion(parametres());
    const nom = `essai-survie-${Date.now()}`;
    const file: Queue = creerFile(nom, connexion.client);
    const intention = { tenantId: TENANT, type: "survie", cle: "dossier-99" };
    await deposer(file, intention, { n: 1 });
    // Sans AOF, le test ne prouverait rien : on l'exige d'abord, lu clé par clé.
    expect(analyserInfo(await connexion.client.info("persistence")).get("aof_enabled")).toBe("1");
    // appendfsync everysec : on attend que le journal soit écrit sur disque avant de couper (borné à 10 s).
    for (let i = 0; i < 20; i++) {
      const p = analyserInfo(await connexion.client.info("persistence"));
      if (p.get("aof_pending_bio_fsync") === "0" && p.get("aof_rewrite_in_progress") === "0") break;
      await attendre(500);
    }
    await attendre(1500);
    await file.close();
    await connexion.quit();

    // Arrêt brutal (SIGKILL) : pas d'instantané RDB à l'arrêt, seul le journal AOF peut garder la tâche.
    const id = conteneur();
    docker("kill", "-s", "KILL", id);
    docker("start", id);
    await attendreSante();

    const apres = await ouvrirConnexion(parametres());
    connexions.push(apres);
    const file2 = creerFile(nom, apres.client);
    ouverts.push({ quit: () => file2.close() });
    const attente = await file2.getJobs(["wait"]);
    expect(attente.map((j) => j.id)).toEqual([idTache(intention)]);
  });
});
