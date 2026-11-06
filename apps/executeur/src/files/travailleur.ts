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
import { decider, ErreurConnecteur, erreurSysteme } from "../noyau/politique-erreurs.ts";
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
  // Une intention reste occupée après 3 fenêtres : le travail est rendu à l'équipe (« à trancher » au journal et à la console), jamais perdu en silence.
  escalader?(travail: Travail, etape: string, code: string): Promise<void>;
  // État voulu lu avant chaque exécution (A-341) : tout état autre que « actif » remet le travail en attente, rien n'est perdu.
  garde?: (instanceId: string) => Promise<{ etat: "actif" | "pause" | "arrete"; arretEnvois?: boolean }>;
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
  if (d.garde) {
    // Arrêt des envois (C-534) : relu avant chaque exécution, même si la poussée a été manquée ou si des réglages sont en cache.
    const voulu = await d.garde(travail.instanceId);
    if (voulu.etat !== "actif" || voulu.arretEnvois === true) return { statut: "remis", delaiMs: d.delaiRemiseMs ?? 5_000 };
  }
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

// Un autre lancement tient l'intention (souvent : plantage, BullMQ redonne le travail avant la fin de la fenêtre). Ce n'est pas un échec : ni essai consommé, ni attente exponentielle.
export class RemiseIntention extends Error {
  constructor(
    readonly libreA: number,
    readonly etape: string,
    readonly cle: string = "",
  ) {
    super("intention_en_cours");
  }
}

// Remises successives tolérées avant l'escalade (3 fenêtres d'occupation).
export const REMISES_MAX = 3;
const compte = (v: unknown) => (Number.isInteger(v) && (v as number) > 0 ? (v as number) : 0);

// Remises de l'occupation en cours, gardées dans les données du travail : la borne vaut PAR occupation (même étape, même clé d'intention).
interface Remise {
  etape: string;
  cle: string;
  libreA: number;
  n: number;
}
const remiseDe = (data: unknown): Remise | undefined => {
  const r = (data as { remise?: Partial<Remise> }).remise;
  return r && typeof r.etape === "string" && typeof r.cle === "string" && compte(r.n) > 0 ? { etape: r.etape, cle: r.cle, libreA: compte(r.libreA), n: compte(r.n) } : undefined;
};
// Données sans le compte de remises : un lancement fini autrement que par une remise clôt l'occupation.
const sansRemise = (data: unknown): Record<string, unknown> => {
  const reste = { ...(data as Record<string, unknown>) };
  delete reste["remise"];
  return reste;
};

// Seule une ErreurConnecteur définitive (ou le bac fermé) abandonne le travail. Tout le reste (base ou Redis injoignable, PgBouncer qui redémarre,
// coupure du processus, erreur inattendue) est passager : l'exécution reprendra, sous le plafond de 5 essais.
export function normaliserErreur(e: unknown): ErreurConnecteur {
  if (e instanceof ErreurConnecteur) return e;
  if (e instanceof BacFerme) return new ErreurConnecteur("definitive", "bac_ferme");
  if (e instanceof CoupureProcessus) return new ErreurConnecteur("passagere", "coupure_processus");
  const systeme = erreurSysteme(e);
  if (systeme) return systeme;
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
      if (e instanceof RemiseIntention) {
        // Une remise, pas un essai : le compte des essais ne bouge pas, le compteur de remises est à part et borné.
        const avant = remiseDe(job.data);
        const remises = avant && avant.etape === e.etape && avant.cle === e.cle ? avant.n : 0; // autre étape ou autre clé : nouvelle occupation, compte à zéro
        if (remises >= REMISES_MAX) {
          if (!d.escalader) throw new UnrecoverableError("intention_en_cours_sans_issue");
          await d.escalader(travail, e.etape, "intention_en_cours_sans_issue");
          await job.updateData(sansRemise(job.data)); // l'occupation est rendue à l'équipe : le compteur repart de zéro
          return;
        }
        await job.updateData({ ...(job.data as object), remise: { etape: e.etape, cle: e.cle, libreA: e.libreA, n: remises + 1 } satisfies Remise });
        await job.moveToDelayed(Date.now() + Math.max(e.libreA - horloge.maintenant(), config.delaiRemiseMs), token);
        throw new DelayedError();
      }
      const essais = compte((job.data as { essais?: unknown }).essais) + 1;
      // Délai calculé par la politique ; BullMQ ne fait que garder le travail jusque-là.
      const p = planifierReprise(normaliserErreur(e), essais, horloge);
      if (p.action === "pause") {
        if (!d.mettreEnPause) throw new UnrecoverableError(p.code);
        await d.mettreEnPause(travail.instanceId);
        return;
      }
      if (p.action === "abandon") throw new UnrecoverableError(p.code);
      await job.updateData({ ...sansRemise(job.data), essais });
      await job.moveToDelayed(Date.now() + p.delaiMs, token);
      throw new DelayedError();
    }
    if (r.statut === "remis") {
      await job.moveToDelayed(Date.now() + r.delaiMs, token);
      throw new DelayedError();
    }
    // Réussite : l'occupation éventuelle est résolue.
    if (remiseDe(job.data)) await job.updateData(sansRemise(job.data));
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
    if (r.statut === "en_cours") throw new RemiseIntention(r.libreA ?? b.horloge.maintenant(), r.etape ?? "", r.cle ?? "");
  };
}

// Escalade : l'étape est inscrite « à trancher » au journal et la console est prévenue (code fermé, aucun contenu).
export function escaladerAvecMoteur(b: BrancheMoteur): NonNullable<Dependances["escalader"]> {
  return async (travail, etape, code) => {
    await new JournalPostgres(b.pool, travail.clientId).inscrire({ instanceId: travail.instanceId, executionId: travail.id, etape, statut: "a_trancher", essai: REMISES_MAX, a: new Date(b.horloge.maintenant()).toISOString() });
    await b.console.envoyer({ type: "a_trancher", instanceId: travail.instanceId, executionId: travail.id, etape, code });
  };
}

export function mettreEnPauseAvecMoteur(b: BrancheMoteur): NonNullable<Dependances["mettreEnPause"]> {
  return (instanceId) => b.console.mettreEnPause(instanceId);
}
