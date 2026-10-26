import { DelayedError, Worker, type Job } from "bullmq";
import type { Redis } from "ioredis";
import type { Artefact } from "../../../../packages/sdk-module/src/emballage/signer.js";
import type { ClePublique } from "../../../../packages/sdk-module/src/emballage/cles-publiques.js";
import { executerIsole } from "../bac-a-sable/processus.ts";
import type { ConfigExecuteur, Palier } from "../config.ts";
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

export function creerTravailleur(
  connexion: Redis,
  config: ConfigExecuteur,
  d: Omit<Dependances, "delaiRemiseMs">,
  lire: (job: Job) => Travail,
): Worker {
  return new Worker(
    d.cellule.nomFile,
    async (job, token) => {
      const r = await traiter(lire(job), { ...d, delaiRemiseMs: config.delaiRemiseMs });
      if (r.statut === "remis") {
        await job.moveToDelayed(Date.now() + r.delaiMs, token);
        throw new DelayedError();
      }
    },
    { connection: connexion, prefix: "axion", concurrency: config.concurrence },
  );
}
