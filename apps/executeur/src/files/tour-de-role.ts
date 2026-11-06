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
  // Remet un travail tiré en tête de la sous-file de son client (échec de l'ajout à la file de la cellule).
  remettre(t: Travail): Promise<void>;
  // Le travail tiré a bien été ajouté à la file de la cellule : il sort de la liste « en transfert ».
  confirmer(t: Travail): Promise<void>;
  // Après un arrêt du processus : remet en tête de leur sous-file les travaux tirés mais jamais confirmés.
  reprendre(): Promise<number>;
}

export class SousFilesMemoire implements SousFiles {
  #m = new Map<string, Travail[]>();
  #transfert = new Map<string, Travail>();
  async remettre(t: Travail) {
    this.#transfert.delete(t.id);
    (this.#m.get(t.clientId) ?? this.#m.set(t.clientId, []).get(t.clientId)!).unshift(t);
  }
  async confirmer(t: Travail) {
    this.#transfert.delete(t.id);
  }
  async reprendre() {
    const tires = [...this.#transfert.values()].reverse();
    for (const t of tires) await this.remettre(t);
    return tires.length;
  }
  async pousser(t: Travail) {
    (this.#m.get(t.clientId) ?? this.#m.set(t.clientId, []).get(t.clientId)!).push(t);
  }
  async tirer(clientId: string) {
    const f = this.#m.get(clientId);
    const t = f?.shift();
    if (f?.length === 0) this.#m.delete(clientId);
    if (t) this.#transfert.set(t.id, t);
    return t;
  }
  async clients() {
    return [...this.#m.keys()];
  }
}

// Clé de la sous-file d'un client : executions:<cellule>:<client>. L'ajout et le retrait de l'index des clients sont atomiques avec la liste.
const POUSSER = `redis.call('RPUSH', KEYS[1], ARGV[1]); redis.call('SADD', KEYS[2], ARGV[2]); return 1`;
// Le travail tiré passe dans la liste « en transfert » (KEYS[3]) jusqu'à sa confirmation : un arrêt entre le tirage et l'ajout ne le perd pas.
const TIRER = `local v = redis.call('LPOP', KEYS[1]); if redis.call('LLEN', KEYS[1]) == 0 then redis.call('SREM', KEYS[2], ARGV[1]) end; if v then redis.call('RPUSH', KEYS[3], v) end; return v`;
const REMETTRE = `redis.call('LREM', KEYS[3], 1, ARGV[1]); redis.call('LPUSH', KEYS[1], ARGV[1]); redis.call('SADD', KEYS[2], ARGV[2]); return 1`;
const PALIERS = new Set<string>(["essentiel", "pro", "etendu"]);

export class SousFilesValkey implements SousFiles {
  constructor(
    private client: Redis,
    private cellule: string,
  ) {}
  private cle = (clientId: string) => `executions:${this.cellule}:${clientId}`;
  private index = () => `executions-clients:${this.cellule}`;
  private transfert = () => `executions-transfert:${this.cellule}`;
  async remettre(t: Travail) {
    await this.client.eval(REMETTRE, 3, this.cle(t.clientId), this.index(), this.transfert(), JSON.stringify(t), t.clientId);
  }
  async confirmer(t: Travail) {
    await this.client.lrem(this.transfert(), 1, JSON.stringify(t));
  }
  // À appeler au démarrage, avant que cette cellule ne tire : les travaux en transfert sont ceux d'un processus arrêté.
  async reprendre() {
    const bruts = await this.client.lrange(this.transfert(), 0, -1);
    for (const brut of bruts.reverse()) await this.remettre(JSON.parse(brut) as Travail);
    return bruts.length;
  }
  async pousser(t: Travail) {
    await this.client.eval(POUSSER, 2, this.cle(t.clientId), this.index(), JSON.stringify(t), t.clientId);
  }
  async tirer(clientId: string) {
    const brut = (await this.client.eval(TIRER, 3, this.cle(clientId), this.index(), this.transfert(), clientId)) as string | null;
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
  // Anneau persistant des clients présents. #ptr désigne le client qui a la main ; #reste = tirages qui lui restent dans son tour (0 : il commence un tour).
  #anneau: string[] = [];
  #ptr = 0;
  #reste = 0;
  constructor(
    private sousFiles: SousFiles,
    private poids: Record<Palier, number>,
  ) {}
  async ajouter(t: Travail): Promise<void> {
    this.#paliers.set(t.clientId, t.palier);
    await this.sousFiles.pousser(t);
  }
  async remettre(t: Travail): Promise<void> {
    await this.sousFiles.remettre(t);
  }
  async confirmer(t: Travail): Promise<void> {
    await this.sousFiles.confirmer(t);
  }
  async reprendre(): Promise<number> {
    return this.sousFiles.reprendre();
  }
  private poidsDe = (c: string) => this.poids[this.#paliers.get(c) ?? "essentiel"];
  private synchroniser(actifs: Set<string>): void {
    // départs : si le client qui a la main disparaît, la main passe à son successeur (même position une fois retiré)
    for (let i = this.#anneau.length - 1; i >= 0; i--) {
      if (actifs.has(this.#anneau[i]!)) continue;
      this.#anneau.splice(i, 1);
      if (i < this.#ptr) this.#ptr--;
      else if (i === this.#ptr) this.#reste = 0;
    }
    if (this.#ptr >= this.#anneau.length) this.#ptr = 0;
    // arrivées : juste avant le pointeur, c'est-à-dire en dernier dans le tour en cours
    const connus = new Set(this.#anneau);
    for (const c of actifs) {
      if (connus.has(c)) continue;
      if (this.#anneau.length === 0) this.#anneau.push(c);
      else {
        this.#anneau.splice(this.#ptr, 0, c);
        this.#ptr++;
      }
    }
  }
  // Le client qui a la main la garde pendant « poids du palier » tirages, puis la main passe au suivant de l'anneau. Un client qui arrive se place en dernier du tour :
  // il attend au plus un tour complet (la somme des poids des autres), même si d'autres clients arrivent sans cesse.
  async suivant(): Promise<Travail | undefined> {
    this.synchroniser(new Set(await this.sousFiles.clients()));
    const n = this.#anneau.length;
    for (let essais = 0; essais < n; essais++) {
      const client = this.#anneau[this.#ptr]!;
      if (this.#reste === 0) this.#reste = this.poidsDe(client);
      const t = await this.sousFiles.tirer(client);
      if (t) {
        this.#reste--;
        if (this.#reste === 0) this.#ptr = (this.#ptr + 1) % n;
        return t;
      }
      this.#ptr = (this.#ptr + 1) % n;
      this.#reste = 0;
    }
    return undefined;
  }
}

// Pompe : tant que la file de la cellule a peu d'attente, y verse les travaux dans l'ordre du tour de rôle. La file BullMQ reste courte, donc l'équité vient du répartiteur.
export async function pomper(r: Repartiteur, file: { getWaitingCount(): Promise<number>; add(nom: string, donnees: Travail, options?: { jobId: string }): Promise<unknown> }, attenteMax: number): Promise<number> {
  let n = 0;
  while ((await file.getWaitingCount()) < attenteMax) {
    const t = await r.suivant();
    if (!t) break;
    // jobId = id du travail : un ajout répété après reprise ne crée pas de doublon. Si l'ajout échoue, le travail repart en tête de sa sous-file.
    try {
      await file.add("execution", t, { jobId: t.id });
    } catch (e) {
      await r.remettre(t);
      throw e;
    }
    await r.confirmer(t);
    n++;
  }
  return n;
}
