import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { writeSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { deriverCleIntention } from "@axion-auto/contrats/src/c4/intention.ts";
import { defineAutomation, type Garantie } from "@axion-auto/sdk-module";
import { manifesteExemple } from "@axion-auto/sdk-module/exemples/module-exemple.ts";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { avecClient, securiserPartitions } from "../../db/connexion.ts";
import { ConnecteurFactice, ConsoleFactice, CoupureProcessus, HorlogeFactice, Machine, type ContexteEtape } from "../index.ts";
import { BoitePostgres } from "./boite-envoi.ts";
import { CurseursPostgres } from "./curseurs.ts";
import { JournalPostgres } from "./journal-etapes.ts";

// Base moteur avec le socle lancé par ops/socle/lancer.sh (job socle-integration). Identifiants de client tirés au hasard : les essais partagent la base.
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
function pool(voie: { host: string; port: number }, user: string, database: string, max = 4): pg.Pool {
  const p = new pg.Pool({ ...voie, user, database, password: motDePasseDe(user), max, connectionTimeoutMillis: 10_000 });
  p.on("error", () => undefined);
  ouverts.push(p);
  return p;
}
const migration = pool(DIRECT, "moteur_migration", "moteur", 2);
const app = pool(PGBOUNCER, "moteur_app", "moteur", 10);

// g : un échec d'essai est écrit sur la sortie d'erreur, lisible dans le journal du job même si le rapporteur le tait.
afterEach((contexte) => {
  if (contexte.task.result?.state === "fail") writeSync(2, `ECHEC ${contexte.task.name} : ${String(contexte.task.result.errors?.[0]?.message ?? "").slice(0, 400)}\n`);
});
afterAll(async () => {
  await Promise.all(ouverts.map((o) => o.end().catch(() => undefined)));
});

// Plusieurs fichiers d'essai migrent la même base : un verrou conseil les met en file ; migrer deux fois ne fait rien.
beforeAll(async () => {
  const dossier = fileURLToPath(new URL("../../../drizzle", import.meta.url));
  const c = await migration.connect();
  try {
    await c.query("SELECT pg_advisory_lock(4017)");
    await migrate(drizzle(c), { migrationsFolder: dossier, migrationsSchema: "public", migrationsTable: "__migrations" });
    await securiserPartitions(c);
    await c.query("SELECT pg_advisory_unlock(4017)");
  } finally {
    c.release();
  }
}, 120_000);

const INSTANCE = randomUUID();
async function execution(tenant: string, instance = INSTANCE) {
  const id = randomUUID();
  await avecClient(app, tenant, (c) => c.query("INSERT INTO executions (tenant_id, id, instance_id, automatisation, debut) VALUES ($1, $2, $3, 'accuse-reception', now())", [tenant, id, instance]));
  return id;
}
const envoyer = async (ctx: ContexteEtape) => void (await ctx.effet("envoyer", "msg-1", {}));
function banc(garantie: Garantie, corps: Record<string, (ctx: ContexteEtape) => Promise<void>> = { e1: envoyer }) {
  const tenant = randomUUID();
  const module = defineAutomation({
    ...manifesteExemple,
    etapes: Object.entries(corps).map(([nom, executer]) => ({ nom, executer })),
    connecteurs: [{ famille: "messagerie", actions: ["envoyer", "classer"], portees: ["envoi"], garantie }],
  });
  const horloge = new HorlogeFactice();
  const connecteur = new ConnecteurFactice();
  connecteur.dedupliquer = garantie === "idempotent_par_cle";
  const console = new ConsoleFactice({ reglages: { actionsAutomatiquesAutorisees: ["envoyer", "classer"], objetAccuse: "Accusé" } });
  const processus = () => {
    const boite = new BoitePostgres(app, tenant);
    // g : la cause d'une erreur de la base est écrite sur la sortie d'erreur (le noyau ne garde que « erreur_inconnue »).
    const ecrire = boite.ecrire.bind(boite);
    boite.ecrire = (...a: Parameters<typeof ecrire>) => ecrire(...a).catch((e: unknown) => (writeSync(2, `BOITE ${String((e as Error).message)}\n`), Promise.reject(e)));
    const ports = { journal: new JournalPostgres(app, tenant), boite, connecteurs: connecteur, console, horloge };
    return { ports, lancer: (executionId: string) => horloge.piloter(new Machine({ module, ports }).lancer(INSTANCE, executionId)) };
  };
  return { tenant, connecteur, processus };
}
const cleDe = (executionId: string) => deriverCleIntention({ instanceId: INSTANCE, executionId, etape: "e1", action: "envoyer", element: "msg-1" });
const etatEnBase = async (tenant: string, cle: string) => (await avecClient(app, tenant, (c) => c.query<{ etat: string }>("SELECT etat FROM intentions WHERE cle_intention = $1", [cle]))).rows[0]?.etat;

describe("reprise et anti-doublon sur la base moteur, avec le socle", { timeout: 60_000 }, () => {
  it("[A-316] @anti-doublon l'intention est validée en base avant l'appel du connecteur (vue par une autre connexion)", async () => {
    const b = banc("idempotent_par_cle");
    const exec = await execution(b.tenant);
    let vue: string | undefined;
    b.connecteur.surAppel = async (cle) => void (vue = await etatEnBase(b.tenant, cle));
    expect((await b.processus().lancer(exec)).statut).toBe("terminee");
    expect(vue).toBe("ecrite");
    expect(await etatEnBase(b.tenant, cleDe(exec))).toBe("faite");
  });

  it("[A-315] l'exécution reprend à l'étape interrompue (journal relu en base)", async () => {
    let coupe = true;
    const vues: string[] = [];
    const b = banc("idempotent_par_cle", {
      e1: async () => void vues.push("e1"),
      e2: async () => {
        if (coupe) {
          coupe = false;
          throw new CoupureProcessus();
        }
        vues.push("e2");
      },
    });
    const exec = await execution(b.tenant);
    const p = b.processus();
    await expect(p.lancer(exec)).rejects.toBeInstanceOf(CoupureProcessus);
    expect((await p.ports.journal.lire(INSTANCE, exec)).map((e) => [e.etape, e.statut])).toEqual([["e1", "faite"]]);
    expect((await b.processus().lancer(exec)).statut).toBe("terminee");
    expect(vues).toEqual(["e1", "e2"]);
  });

  it("[A-318] @anti-doublon intention écrite sans issue + message trouvé après coup → faite, sans renvoi", async () => {
    const b = banc("verifiable_apres_coup");
    const exec = await execution(b.tenant);
    b.connecteur.verification = "trouvee";
    await b.processus().ports.boite.ecrire({ cle: cleDe(exec), instanceId: INSTANCE, executionId: exec, etape: "e1", element: "msg-1", action: "envoyer", garantie: "verifiable_apres_coup" }, { proprietaire: "mort", jusqua: 0 }, 1);
    expect((await b.processus().lancer(exec)).statut).toBe("terminee");
    expect(b.connecteur.appels).toEqual([]);
    expect(await etatEnBase(b.tenant, cleDe(exec))).toBe("faite");
  });

  it("[A-319] @anti-doublon intention écrite sans issue + garantie au_plus_une_fois → a_trancher, aucune nouvelle tentative", async () => {
    const b = banc("au_plus_une_fois");
    const exec = await execution(b.tenant);
    await b.processus().ports.boite.ecrire({ cle: cleDe(exec), instanceId: INSTANCE, executionId: exec, etape: "e1", element: "msg-1", action: "envoyer", garantie: "au_plus_une_fois" }, { proprietaire: "mort", jusqua: 0 }, 1);
    expect((await b.processus().lancer(exec)).statut).toBe("a_trancher");
    expect((await b.processus().lancer(exec)).statut).toBe("a_trancher");
    expect(b.connecteur.appels).toEqual([]);
    expect(await etatEnBase(b.tenant, cleDe(exec))).toBe("a_trancher");
  });

  it("[A-312] @isolation un client ne lit ni le journal, ni les intentions, ni les curseurs d'un autre ; la même clé existe chez les deux", async () => {
    const A = banc("idempotent_par_cle");
    const B = banc("idempotent_par_cle");
    const execA = await execution(A.tenant);
    await A.processus().lancer(execA);
    expect(await etatEnBase(A.tenant, cleDe(execA))).toBe("faite");
    expect(await etatEnBase(B.tenant, cleDe(execA))).toBeUndefined();
    expect(await new BoitePostgres(app, B.tenant).lire(cleDe(execA))).toBeUndefined();
    expect(await new JournalPostgres(app, B.tenant).lire(INSTANCE, execA)).toEqual([]);
    await new CurseursPostgres(app, A.tenant).ecrire(INSTANCE, "courrier", "uid-1");
    expect(await new CurseursPostgres(app, B.tenant).lire(INSTANCE, "courrier")).toBeUndefined();
    // Une exécution d'un autre client est refusée, pas devinée.
    await expect(new JournalPostgres(app, B.tenant).inscrire({ instanceId: INSTANCE, executionId: execA, etape: "e1", statut: "faite", essai: 1, a: new Date().toISOString() })).rejects.toThrow();
  });

  it("[A-374] le curseur survit au processus : écrit, remplacé, relu", async () => {
    const tenant = randomUUID();
    await new CurseursPostgres(app, tenant).ecrire(INSTANCE, "courrier", "uid-1");
    await new CurseursPostgres(app, tenant).ecrire(INSTANCE, "courrier", "uid-2");
    expect(await new CurseursPostgres(app, tenant).lire(INSTANCE, "courrier")).toBe("uid-2");
  });
});
