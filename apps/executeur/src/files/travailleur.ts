import { DelayedError, Worker, type Job } from "bullmq";
import type { Redis } from "ioredis";
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

// Sans place : le travail est remis en attente avec délai, jamais perdu ni exécuté.
export async function traiter(travail: Travail, d: Dependances): Promise<Resultat> {
  d.cellule.accepter(travail.instanceId);
  const proprietaire = `${travail.instanceId}:${travail.id}`;
  if (!(await d.semaphore.acquerir(travail.clientId, travail.palier, proprietaire))) {
    return { statut: "remis", delaiMs: d.delaiRemiseMs ?? 5_000 };
  }
  try {
    await d.executer(travail);
    return { statut: "fait" };
  } finally {
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
    { connection: connexion, prefix: "axion" },
  );
}
