import { Queue, type Job } from "bullmq";
import { Redis } from "ioredis";
import { afterAll, describe, expect, it } from "vitest";
import { chargerConfig } from "../config.ts";
import { Cellule } from "./cellule.ts";
import { PlanificateursBullMQ, synchroniser } from "./planificateur.ts";
import { PlacesValkey, Semaphore } from "./semaphore.ts";
import { creerTravailleur, type Travail } from "./travailleur.ts";

// Contre le Valkey du socle (job socle-integration) : TEST_VALKEY_HOTE et TEST_VALKEY_PORT, fournis par le job.
const hote = process.env.TEST_VALKEY_HOTE ?? "";
const port = process.env.TEST_VALKEY_PORT ?? "6379";
const unique = () => `essai-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const config = chargerConfig({ VALKEY_HOTE: hote, VALKEY_PORT: port, EXECUTEUR_BAIL_PLACE_MS: "400", EXECUTEUR_CONCURRENCE: "8" });
const connexion = () => new Redis({ host: hote, port: Number(port), maxRetriesPerRequest: null });

const ferme: { quit?: () => Promise<unknown>; close?: () => Promise<unknown> }[] = [];
afterAll(async () => {
  for (const f of ferme) await (f.close ?? f.quit)?.call(f);
});
const attendre = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

describe("places Valkey", () => {
  it("[A-325] 20 prises en parallèle pour un client Essentiel donnent 2 succès, et une place revient après le bail", async () => {
    const c = connexion();
    ferme.push(c);
    const sem = new Semaphore(new PlacesValkey(c, unique()), config);
    const r = await Promise.all(Array.from({ length: 20 }, (_, i) => sem.acquerir("client-a", "essentiel", `p${i}`)));
    expect(r.filter(Boolean)).toHaveLength(2);
    expect(await sem.acquerir("client-b", "essentiel", "x")).toBe(true);
    await attendre(config.bailPlaceMs + 100);
    expect(await sem.acquerir("client-a", "essentiel", "neuf")).toBe(true);
  });
  it("[A-325] prolonger garde la place au-delà du bail, rendre la libère", async () => {
    const c = connexion();
    ferme.push(c);
    const sem = new Semaphore(new PlacesValkey(c, unique()), config);
    await sem.acquerir("client-a", "essentiel", "p1");
    await sem.acquerir("client-a", "essentiel", "p2");
    for (let i = 0; i < 4; i++) {
      await attendre(config.bailPlaceMs / 2);
      expect(await sem.prolonger("client-a", "p1")).toBe(true);
    }
    expect(await sem.acquerir("client-a", "essentiel", "p3")).toBe(false);
    await sem.liberer("client-a", "p1");
    expect(await sem.acquerir("client-a", "essentiel", "p3")).toBe(true);
  });
});

describe("planificateurs BullMQ", () => {
  it("[A-311] synchroniser deux fois ne réécrit rien : le gabarit relu de Valkey est identique", async () => {
    const c = connexion();
    const file = new Queue(unique(), { connection: c, prefix: "axion" });
    ferme.push(c, file);
    const port1 = new PlanificateursBullMQ(file);
    const voulus = [{ instanceId: "inst-1", etat: "actif" as const, arretEnvois: false, version: 1, declencheurs: [{ type: "cron" as const, id: "matin", expression: "0 8 * * 1-5" }] }];
    await synchroniser(port1, voulus);
    const [relu] = await port1.lister();
    expect(relu?.gabarit).toEqual({ instanceId: "inst-1" });
    let ecritures = 0;
    const compte = { lister: () => port1.lister(), retirer: (id: string) => port1.retirer(id), upsert: async (p: Parameters<typeof port1.upsert>[0]) => (ecritures++, port1.upsert(p)) };
    await synchroniser(compte, voulus);
    expect(ecritures).toBe(0);
    await synchroniser(compte, [{ ...voulus[0]!, etat: "pause" }]);
    expect(await port1.lister()).toEqual([]);
  });
});

describe("travailleur BullMQ", () => {
  it("[A-325] le travailleur traite plusieurs clients à la fois, et jamais plus de 2 travaux d'un client Essentiel", async () => {
    const c = connexion();
    const nom = unique();
    const cellule = new Cellule(nom, ["inst-1"]);
    const file = new Queue(cellule.nomFile, { connection: c, prefix: "axion" });
    const sem = new Semaphore(new PlacesValkey(connexion(), nom), config);
    let total = 0;
    let maxTotal = 0;
    const parClient = new Map<string, number>();
    let maxClientA = 0;
    let faits = 0;
    const executer = async (t: Travail) => {
      total++;
      maxTotal = Math.max(maxTotal, total);
      parClient.set(t.clientId, (parClient.get(t.clientId) ?? 0) + 1);
      if (t.clientId === "client-a") maxClientA = Math.max(maxClientA, parClient.get(t.clientId)!);
      await attendre(150);
      parClient.set(t.clientId, parClient.get(t.clientId)! - 1);
      total--;
      faits++;
    };
    const lire = (job: Job): Travail => job.data as Travail;
    const w = creerTravailleur(connexion(), { ...config, delaiRemiseMs: 100 }, { cellule, semaphore: sem, executer }, lire);
    ferme.push(c, file, w);
    const travaux: Travail[] = [
      ...Array.from({ length: 6 }, (_, i) => ({ id: `a${i}`, instanceId: "inst-1", clientId: "client-a", palier: "essentiel" as const })),
      ...Array.from({ length: 3 }, (_, i) => ({ id: `b${i}`, instanceId: "inst-1", clientId: `client-b${i}`, palier: "essentiel" as const })),
    ];
    for (const t of travaux) await file.add("execution", t, { jobId: t.id });
    for (let i = 0; i < 100 && faits < travaux.length; i++) await attendre(100);
    expect(faits).toBe(travaux.length);
    expect(maxClientA).toBeLessThanOrEqual(2);
    expect(maxTotal).toBeGreaterThan(2);
  }, 30_000);
});
