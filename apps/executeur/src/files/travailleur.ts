import { DelayedError, UnrecoverableError, Worker, type Job } from "bullmq";
import type { Redis } from "ioredis";
import type { Pool } from "pg";
import type { defineAutomation } from "@axion-auto/sdk-module";
import type { Artefact } from "../../../../packages/sdk-module/src/emballage/signer.js";
import type { ClePublique } from "../../../../packages/sdk-module/src/emballage/cles-publiques.js";
import { executerIsole } from "../bac-a-sable/processus.ts";
import type { ConfigExecuteur, Palier } from "../config.ts";
import { HorlogeSysteme } from "../noyau/horloge.ts";
import { Machine } from "../noyau/machine.ts";
import { BoitePostgres } from "../noyau/postgres/boite-envoi.ts";
import { JournalPostgres } from "../noyau/postgres/journal-etapes.ts";
import { decider, ErreurConnecteur } from "../noyau/politique-erreurs.ts";
import { CoupureProcessus, type Connecteurs, type Console, type Horloge } from "../noyau/ports.ts";
import type { Cellule } from "./cellule.ts";
import type { Semaphore } from "./semaphore.ts";

export interface Travail {
  id: string;
  instanceId: string;
  clientId: string;
  palier: Palier;
}

export type Resultat = { statut: "fait" } | { statut: "remis"; delaiMs: number };

export interface Dependances {
  cellule: Cellule;
  semaphore: Semaphore;
  executer(travail: Travail): Promise<void>;
  // Erreur d'identification hors de la machine : la console met l'instance en pause (A-322).
  mettreEnPause?(instanceId: string): Promise<void>;
  delaiRemiseMs?: number;
}

// Interrupteur fermé par défaut : tant qu'il n'est pas ouvert, aucun module ne se lance.
export class BacFerme extends Error {
  readonly code = "bac_ferme";
  constructor() {
    super("bac_ferme");
  }
}

export interface OptionsBac {
  actif?: boolean;
  cles?: readonly ClePublique[];
}

// Chaque travail tourne dans un processus enfant jetable (T4-19) ; le résultat n'est pas gardé ici.
export function executerEnBac(chargeur: (travail: Travail) => Promise<Artefact>, options: OptionsBac = {}): Dependances["executer"] {
  return async (travail) => {
    if (options.actif !== true) throw new BacFerme();
    const r = await executerIsole(await chargeur(travail), { executionId: travail.id, entree: { instanceId: travail.instanceId }, cles: options.cles });
    if (r.statut !== "fait") throw new Error("bac_a_sable_echec");
  };
}

// Sans place : le travail est remis en attente avec délai, jamais perdu ni exécuté.
export async function traiter(travail: Travail, d: Dependances): Promise<Resultat> {
  d.cellule.accepter(travail.instanceId);
  const proprietaire = `${travail.instanceId}:${travail.id}`;
  if (!(await d.semaphore.acquerir(travail.clientId, travail.palier, proprietaire))) {
    return { statut: "remis", delaiMs: d.delaiRemiseMs ?? 5_000 };
  }
  // Le bail est renouvelé tant que le travail tourne : sans cela, une place expirerait en plein travail.
  const renouveler = setInterval(() => {
    d.semaphore.prolonger(travail.clientId, proprietaire).catch(() => undefined);
  }, Math.max(1, Math.floor(d.semaphore.bailMs / 3)));
  try {
    await d.executer(travail);
    return { statut: "fait" };
  } finally {
    clearInterval(renouveler);
    await d.semaphore.liberer(travail.clientId, proprietaire);
  }
}

const horlogeSysteme = new HorlogeSysteme();

export type Gestionnaire = (job: Pick<Job, "data" | "updateData" | "moveToDelayed">, token?: string) => Promise<void>;

const PG_PASSAGERES = new Set(["57P01", "57P03", "40001", "40P01"]);
const RESEAU = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH"]);

// Seule une ErreurConnecteur définitive (ou le bac fermé) abandonne le travail. Tout le reste (base ou Redis injoignable, PgBouncer qui redémarre,
// coupure du processus, erreur inattendue) est passager : l'exécution reprendra, sous le plafond de 5 essais.
export function normaliserErreur(e: unknown): ErreurConnecteur {
  if (e instanceof ErreurConnecteur) return e;
  if (e instanceof BacFerme) return new ErreurConnecteur("definitive", "bac_ferme");
  if (e instanceof CoupureProcessus) return new ErreurConnecteur("passagere", "coupure_processus");
  const code = typeof (e as { code?: unknown } | null)?.code === "string" ? (e as { code: string }).code : "";
  if (code.startsWith("08") || PG_PASSAGERES.has(code)) return new ErreurConnecteur("passagere", "base_injoignable");
  if (RESEAU.has(code)) return new ErreurConnecteur("passagere", "reseau");
  return new ErreurConnecteur("passagere", "erreur_inattendue");
}

// Le compte des essais est dans les données du travail : moveToDelayed ne fait pas monter attemptsMade (skipAttempt de BullMQ).
export function creerGestionnaire(config: Pick<ConfigExecuteur, "delaiRemiseMs">, d: Omit<Dependances, "delaiRemiseMs">, lire: (job: Pick<Job, "data">) => Travail, horloge: Horloge = horlogeSysteme): Gestionnaire {
  return async (job, token) => {
    const travail = lire(job);
    let r: Resultat;
    try {
      r = await traiter(travail, { ...d, delaiRemiseMs: config.delaiRemiseMs });
    } catch (e) {
      const dejaFaits = Number((job.data as { essais?: unknown }).essais);
      const essais = (Number.isInteger(dejaFaits) && dejaFaits > 0 ? dejaFaits : 0) + 1;
      // Délai calculé par la politique ; BullMQ ne fait que garder le travail jusque-là.
      const p = planifierReprise(normaliserErreur(e), essais, horloge);
      if (p.action === "pause") {
        if (!d.mettreEnPause) throw new UnrecoverableError(p.code);
        await d.mettreEnPause(travail.instanceId);
        return;
      }
      if (p.action === "abandon") throw new UnrecoverableError(p.code);
      await job.updateData({ ...(job.data as object), essais });
      await job.moveToDelayed(Date.now() + p.delaiMs, token);
      throw new DelayedError();
    }
    if (r.statut === "remis") {
      await job.moveToDelayed(Date.now() + r.delaiMs, token);
      throw new DelayedError();
    }
  };
}

export function creerTravailleur(connexion: Redis, config: ConfigExecuteur, d: Omit<Dependances, "delaiRemiseMs">, lire: (job: Job) => Travail): Worker {
  return new Worker(d.cellule.nomFile, creerGestionnaire(config, d, (job) => lire(job as Job)), { connection: connexion, prefix: "axion", concurrency: config.concurrence });
}

export type Reprise = { action: "reporter"; delaiMs: number } | { action: "pause"; code: string } | { action: "abandon"; code: string };

// L'attente avant un nouvel essai vient de la politique des erreurs (A-321, A-324), jamais de l'option « backoff » de BullMQ.
// Un seul plafond : 5 essais pour une erreur passagère. Une erreur d'identification met l'instance en pause (A-322).
export function planifierReprise(erreur: unknown, essaisFaits: number, horloge: Horloge): Reprise {
  const d = decider(erreur, essaisFaits, horloge);
  if (d.action === "reessayer") return { action: "reporter", delaiMs: d.attenteMs };
  return d.action === "pause" ? { action: "pause", code: d.code } : { action: "abandon", code: d.code };
}

export interface BrancheMoteur {
  pool: Pool;
  module: ReturnType<typeof defineAutomation>;
  console: Console;
  connecteurs: Connecteurs;
  horloge: Horloge;
}

// Une seule boîte d'envoi par client et par processus : le bail et les échecs connus y sont partagés entre les travaux du même client.
// Entre processus, l'âge de l'intention en base fait foi (ADR 0102).
const boites = new WeakMap<Pool, Map<string, BoitePostgres>>();
function boiteDe(pool: Pool, clientId: string): BoitePostgres {
  let parClient = boites.get(pool);
  if (!parClient) boites.set(pool, (parClient = new Map()));
  let boite = parClient.get(clientId);
  if (!boite) parClient.set(clientId, (boite = new BoitePostgres(pool, clientId)));
  return boite;
}

// Remplace les ports en mémoire : journal et boîte d'envoi sont ceux de la base moteur, pour le client du travail.
export function executerAvecMoteur(b: BrancheMoteur): Dependances["executer"] {
  return async (travail) => {
    const ports = { journal: new JournalPostgres(b.pool, travail.clientId), boite: boiteDe(b.pool, travail.clientId), connecteurs: b.connecteurs, console: b.console, horloge: b.horloge };
    // reporter : le plafond total de 5 essais est compté par le travailleur, la machine ne rejoue plus les erreurs passagères (ADR 0102).
    const r = await new Machine({ module: b.module, ports, reporter: true }).lancer(travail.instanceId, travail.id);
    if (r.statut === "reportee") throw r.cause;
    // Hors de la machine : seul un travail qui n'a ni fini ni échoué est relancé par BullMQ.
    if (r.statut === "en_cours") throw new ErreurConnecteur("passagere", "intention_en_cours");
  };
}

export function mettreEnPauseAvecMoteur(b: BrancheMoteur): NonNullable<Dependances["mettreEnPause"]> {
  return (instanceId) => b.console.mettreEnPause(instanceId);
}
