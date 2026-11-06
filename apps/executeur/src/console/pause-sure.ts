// Pause sûre (A-342) et attente des déclenchements pendant une pause (B-437).
export const UNE_JOURNEE_MS = 24 * 3600_000;

export interface Alertes {
  alerter(code: string, detail?: { instanceId?: string }): void | Promise<void>;
}

// Le temps se compte depuis la dernière réponse REÇUE POUR CETTE INSTANCE, sur une horloge MONOTONE (jamais l'heure du serveur seule) :
// la réponse d'une autre instance de la cellule ne prouve rien pour celle-ci.
export class PauseSure {
  #derniere = new Map<string, number>();
  #alertee = new Set<string>();
  readonly #o: { alertes: Alertes; maintenantMs: () => number; delaiMs: number };
  readonly #debut: number;
  constructor(o: { alertes: Alertes; maintenantMs: () => number; delaiMs?: number }) {
    this.#o = { delaiMs: UNE_JOURNEE_MS, ...o };
    this.#debut = o.maintenantMs(); // au démarrage, le silence se compte depuis le démarrage
  }
  // La console a répondu pour cette instance : fin de l'épisode, reprise automatique.
  reponseRecue(instanceId: string): void {
    this.#derniere.set(instanceId, this.#o.maintenantMs());
    this.#alertee.delete(instanceId);
  }
  // Vrai si la console est muette pour cette instance depuis plus de 24 h ; une seule alerte par épisode.
  evaluer(instanceId: string): boolean {
    if (this.#o.maintenantMs() - (this.#derniere.get(instanceId) ?? this.#debut) <= this.#o.delaiMs) return false;
    if (!this.#alertee.has(instanceId)) {
      this.#alertee.add(instanceId);
      void Promise.resolve(this.#o.alertes.alerter("console_muette_pause_sure", { instanceId })).catch(() => undefined);
    }
    return true;
  }
}

// Stockage durable de la file d'attente : une liste ordonnée par instance ; un élément se retire par identité, jamais « le premier ».
export interface StockageAttente<T> {
  lire(instanceId: string): Promise<T[]>;
  ajouter(instanceId: string, item: T): Promise<void>;
  retirer(instanceId: string, item: T): Promise<void>;
}
export class StockageMemoire<T> implements StockageAttente<T> {
  #m = new Map<string, T[]>();
  async lire(i: string) {
    return [...(this.#m.get(i) ?? [])];
  }
  async ajouter(i: string, item: T) {
    this.#m.set(i, [...(this.#m.get(i) ?? []), item]);
  }
  async retirer(i: string, item: T) {
    const cle = JSON.stringify(item);
    const l = [...(this.#m.get(i) ?? [])];
    const k = l.findIndex((x) => JSON.stringify(x) === cle);
    if (k >= 0) l.splice(k, 1);
    this.#m.set(i, l);
  }
}
// Valkey : survit au redémarrage de l'exécuteur. Les éléments ne contiennent que des identifiants (instance, clé de travail).
export interface RedisListe {
  rpush(cle: string, valeur: string): Promise<unknown>;
  lrange(cle: string, debut: number, fin: number): Promise<string[]>;
  lrem(cle: string, n: number, valeur: string): Promise<unknown>;
}
export class StockageValkey<T> implements StockageAttente<T> {
  constructor(
    private redis: RedisListe,
    private prefixe: string,
  ) {}
  #cle = (i: string) => `${this.prefixe}:${i}`;
  async lire(i: string) {
    return (await this.redis.lrange(this.#cle(i), 0, -1)).map((x) => JSON.parse(x) as T);
  }
  async ajouter(i: string, item: T) {
    await this.redis.rpush(this.#cle(i), JSON.stringify(item));
  }
  async retirer(i: string, item: T) {
    await this.redis.lrem(this.#cle(i), 1, JSON.stringify(item));
  }
}

// Ordre conservé par instance. La limite n'a pas de défaut : elle vient de la configuration (1 000 en test, [À DÉFINIR] en production).
// Au-delà : refus compté et alerte, jamais d'effacement d'un déclenchement déjà gardé.
export class AttenteEnPause<T> {
  #verrous = new Map<string, Promise<unknown>>();
  refuses = 0;
  constructor(
    private limite: number,
    private alertes: Alertes,
    private stockage: StockageAttente<T> = new StockageMemoire<T>(),
  ) {
    if (!Number.isInteger(limite) || limite < 1) throw new Error("limite de la file d'attente invalide");
  }
  async taille(instanceId: string): Promise<number> {
    return (await this.stockage.lire(instanceId)).length;
  }
  // Une seule opération à la fois par instance (dépôt et reprise ne s'entremêlent pas).
  exclusif<R>(instanceId: string, fn: () => Promise<R>): Promise<R> {
    const suite = (this.#verrous.get(instanceId) ?? Promise.resolve()).catch(() => undefined).then(fn);
    this.#verrous.set(instanceId, suite);
    return suite;
  }
  async deposer(instanceId: string, item: T): Promise<boolean> {
    if ((await this.taille(instanceId)) >= this.limite) {
      this.refuses++;
      void Promise.resolve(this.alertes.alerter("file_pause_pleine", { instanceId })).catch(() => undefined);
      return false;
    }
    await this.stockage.ajouter(instanceId, item);
    return true;
  }
  enAttente(instanceId: string): Promise<T[]> {
    return this.stockage.lire(instanceId);
  }
  retirer(instanceId: string, item: T): Promise<void> {
    return this.stockage.retirer(instanceId, item);
  }
}
