import type { Redis } from "ioredis";
import type { Palier } from "../config.ts";
import type { Travail } from "./travailleur.ts";

// Tour de rôle entre clients (A-414) : une sous-file par client et un répartiteur qui tire le client suivant, pondéré par le palier.
// Écrit à la main sur des files ordinaires (listes) : aucune fonction payante de la bibliothèque de files n'est utilisée (T1A-02).
// Un travail qui n'a pas de place chez le travailleur est remis en attente par BullMQ (traiter) : il ne repasse jamais devant les autres sous-files.
export interface SousFiles {
  pousser(t: Travail): Promise<void>;
  tirer(clientId: string): Promise<Travail | undefined>;
  // Clients dont la sous-file n'est pas vide.
  clients(): Promise<string[]>;
}

export class SousFilesMemoire implements SousFiles {
  #m = new Map<string, Travail[]>();
  async pousser(t: Travail) {
    (this.#m.get(t.clientId) ?? this.#m.set(t.clientId, []).get(t.clientId)!).push(t);
  }
  async tirer(clientId: string) {
    const f = this.#m.get(clientId);
    const t = f?.shift();
    if (f?.length === 0) this.#m.delete(clientId);
    return t;
  }
  async clients() {
    return [...this.#m.keys()];
  }
}

// Clé de la sous-file d'un client : executions:<cellule>:<client>. L'ajout et le retrait de l'index des clients sont atomiques avec la liste.
const POUSSER = `redis.call('RPUSH', KEYS[1], ARGV[1]); redis.call('SADD', KEYS[2], ARGV[2]); return 1`;
const TIRER = `local v = redis.call('LPOP', KEYS[1]); if redis.call('LLEN', KEYS[1]) == 0 then redis.call('SREM', KEYS[2], ARGV[1]) end; return v`;
const PALIERS = new Set<string>(["essentiel", "pro", "etendu"]);

export class SousFilesValkey implements SousFiles {
  constructor(
    private client: Redis,
    private cellule: string,
  ) {}
  private cle = (clientId: string) => `executions:${this.cellule}:${clientId}`;
  private index = () => `executions-clients:${this.cellule}`;
  async pousser(t: Travail) {
    await this.client.eval(POUSSER, 2, this.cle(t.clientId), this.index(), JSON.stringify(t), t.clientId);
  }
  async tirer(clientId: string) {
    const brut = (await this.client.eval(TIRER, 2, this.cle(clientId), this.index(), clientId)) as string | null;
    if (brut === null) return undefined;
    const t = JSON.parse(brut) as Travail;
    // Valeur illisible : écartée plutôt que d'arrêter le tour des autres clients.
    return typeof t.id === "string" && typeof t.instanceId === "string" && t.clientId === clientId && PALIERS.has(t.palier) ? t : undefined;
  }
  async clients() {
    return this.client.smembers(this.index());
  }
}

export class Repartiteur {
  #paliers = new Map<string, Palier>();
  #ordre: string[] = [];
  #courant: string | undefined;
  #reste = 0;
  constructor(
    private sousFiles: SousFiles,
    private poids: Record<Palier, number>,
  ) {}
  async ajouter(t: Travail): Promise<void> {
    this.#paliers.set(t.clientId, t.palier);
    await this.sousFiles.pousser(t);
  }
  private poidsDe = (c: string) => this.poids[this.#paliers.get(c) ?? "essentiel"];
  // Le client courant garde la main pendant « poids du palier » tirages, puis le suivant dans l'ordre d'arrivée. Un client qui arrive passe après les présents :
  // il attend au plus un tour complet (la somme des poids des autres).
  async suivant(): Promise<Travail | undefined> {
    const actifs = new Set(await this.sousFiles.clients());
    const avant = this.#ordre;
    const rang = this.#courant === undefined ? -1 : avant.indexOf(this.#courant);
    const ordre = avant.filter((c) => actifs.has(c));
    const connus = new Set(ordre);
    for (const c of actifs) if (!connus.has(c)) ordre.push(c);
    this.#ordre = ordre;
    if (ordre.length === 0) return undefined;
    let pos: number;
    if (this.#courant !== undefined && actifs.has(this.#courant) && this.#reste > 0) pos = ordre.indexOf(this.#courant);
    else {
      // suivant le client courant : celui qui le suit parmi les présents (s'il a disparu, celui qui a pris sa place)
      pos = (rang < 0 ? 0 : avant.slice(0, rang + (actifs.has(this.#courant!) ? 1 : 0)).filter((c) => actifs.has(c)).length) % ordre.length;
      this.#reste = this.poidsDe(ordre[pos]!);
    }
    for (let essais = 0; essais < ordre.length; essais++) {
      const client = ordre[pos]!;
      const t = await this.sousFiles.tirer(client);
      if (t) {
        this.#courant = client;
        this.#reste--;
        return t;
      }
      pos = (pos + 1) % ordre.length;
      this.#reste = this.poidsDe(ordre[pos]!);
    }
    return undefined;
  }
}

// Pompe : tant que la file de la cellule a peu d'attente, y verse les travaux dans l'ordre du tour de rôle. La file BullMQ reste courte, donc l'équité vient du répartiteur.
export async function pomper(r: Repartiteur, file: { getWaitingCount(): Promise<number>; add(nom: string, donnees: Travail): Promise<unknown> }, attenteMax: number): Promise<number> {
  let n = 0;
  while ((await file.getWaitingCount()) < attenteMax) {
    const t = await r.suivant();
    if (!t) break;
    await file.add("execution", t);
    n++;
  }
  return n;
}
