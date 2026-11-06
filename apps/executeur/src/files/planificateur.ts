import type { Queue } from "bullmq";
import type { EtatVoulu } from "@axion-auto/contrats/src/c4/etat-voulu.ts";
import type { AttenteEnPause } from "../console/pause-sure.ts";
import type { LectureEtat } from "../console/etat-voulu.ts";
import { versRepetition, type Declencheur, type Repetition } from "./declencheurs.ts";

export type EtatVouluPlanifie = EtatVoulu & { declencheurs: Declencheur[] };

export interface Planification {
  id: string;
  repetition: Repetition;
  // Seulement l'identifiant d'instance : jamais les réglages.
  gabarit: { instanceId: string };
}

export interface Planificateurs {
  lister(): Promise<Planification[]>;
  upsert(p: Planification): Promise<void>;
  retirer(id: string): Promise<void>;
}

const signature = (p: Planification) => JSON.stringify([p.repetition, p.gabarit]);

// Idempotent : on ne réécrit que ce qui diffère, on retire ce qui n'est plus voulu (pause, arrêt, déclencheur supprimé).
export async function synchroniser(port: Planificateurs, voulus: EtatVouluPlanifie[]): Promise<void> {
  const cible = new Map<string, Planification>();
  for (const e of voulus) {
    if (e.etat !== "actif") continue;
    for (const d of e.declencheurs) {
      const id = `${e.instanceId}:${d.id}`;
      cible.set(id, { id, repetition: versRepetition(d), gabarit: { instanceId: e.instanceId } });
    }
  }
  const existants = new Map((await port.lister()).map((p) => [p.id, p]));
  for (const id of existants.keys()) if (!cible.has(id)) await port.retirer(id);
  for (const p of cible.values()) {
    const actuel = existants.get(p.id);
    if (!actuel || signature(actuel) !== signature(p)) await port.upsert(p);
  }
}

export class PlanificateursMemoire implements Planificateurs {
  #m = new Map<string, Planification>();
  ecritures = 0;
  dernier: Planification | undefined;
  liste = () => [...this.#m.keys()];
  async lister() {
    return [...this.#m.values()];
  }
  async upsert(p: Planification) {
    this.ecritures++;
    this.dernier = p;
    this.#m.set(p.id, p);
  }
  async retirer(id: string) {
    this.#m.delete(id);
  }
}

export class PlanificateursBullMQ implements Planificateurs {
  constructor(private file: Queue) {}
  async lister(): Promise<Planification[]> {
    const js = await this.file.getJobSchedulers();
    return js.map((j) => ({
      id: j.key,
      repetition: j.pattern ? { pattern: j.pattern, tz: j.tz ?? "" } : { every: Number(j.every) },
      gabarit: { instanceId: String((j.template?.data as { instanceId?: string } | undefined)?.instanceId ?? "") },
    }));
  }
  async upsert(p: Planification) {
    await this.file.upsertJobScheduler(p.id, p.repetition, { name: "execution", data: p.gabarit });
  }
  async retirer(id: string) {
    await this.file.removeJobScheduler(id);
  }
}

// Déclenchements reçus (B-437) : en pause, ils sont gardés dans l'ordre jusqu'à la limite configurée ; au-delà, refus compté et alerte.
export interface Declenchement {
  instanceId: string;
  jobId: string;
}
export interface DepsDeclenchement {
  garde: (instanceId: string) => Promise<LectureEtat>;
  attente: AttenteEnPause<Declenchement>;
  ajouter: (d: Declenchement) => Promise<void>;
}

// Remet en file dans l'ordre d'arrivée, une reprise à la fois par instance ; un élément est retiré PAR IDENTITÉ, après sa remise (une panne ne perd rien).
async function vider(d: DepsDeclenchement, instanceId: string): Promise<number> {
  let n = 0;
  for (let item = (await d.attente.enAttente(instanceId))[0]; item !== undefined; item = (await d.attente.enAttente(instanceId))[0]) {
    await d.ajouter(item);
    await d.attente.retirer(instanceId, item);
    n++;
  }
  return n;
}
export const reprendreDeclenchements = (d: DepsDeclenchement, instanceId: string): Promise<number> => d.attente.exclusif(instanceId, () => vider(d, instanceId));

export function declencher(d: DepsDeclenchement, item: Declenchement): Promise<"envoye" | "garde" | "refuse"> {
  return d.attente.exclusif(item.instanceId, async () => {
    if ((await d.garde(item.instanceId)).etat !== "actif") return (await d.attente.deposer(item.instanceId, item)) ? "garde" : "refuse";
    await vider(d, item.instanceId); // ceux arrivés pendant la pause passent d'abord
    await d.ajouter(item);
    return "envoye";
  });
}
