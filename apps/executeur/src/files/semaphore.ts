import type { Redis } from "ioredis";
import type { ConfigExecuteur, Palier } from "../config.ts";

// Places par CLIENT (pas par instance) : un bail expire pour qu'une place perdue revienne.
export interface Places {
  prendre(clientId: string, limite: number, proprietaire: string, bailMs: number): Promise<boolean>;
  rendre(clientId: string, proprietaire: string): Promise<void>;
}

export class Semaphore {
  constructor(
    private places: Places,
    private config: Pick<ConfigExecuteur, "placesParPalier" | "bailPlaceMs">,
  ) {}
  acquerir(clientId: string, palier: Palier, proprietaire: string): Promise<boolean> {
    return this.places.prendre(clientId, this.config.placesParPalier[palier], proprietaire, this.config.bailPlaceMs);
  }
  liberer(clientId: string, proprietaire: string): Promise<void> {
    return this.places.rendre(clientId, proprietaire);
  }
}

export class PlacesMemoire implements Places {
  #m = new Map<string, Map<string, number>>();
  constructor(private maintenant: () => number) {}
  async prendre(clientId: string, limite: number, proprietaire: string, bailMs: number) {
    const t = this.maintenant();
    const pris = this.#m.get(clientId) ?? new Map<string, number>();
    for (const [p, fin] of pris) if (fin <= t) pris.delete(p);
    this.#m.set(clientId, pris);
    if (!pris.has(proprietaire) && pris.size >= limite) return false;
    pris.set(proprietaire, t + bailMs);
    return true;
  }
  async rendre(clientId: string, proprietaire: string) {
    this.#m.get(clientId)?.delete(proprietaire);
  }
}

// Atomique : purge des baux expirés, test de la limite et prise en un seul script.
const PRENDRE = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
if redis.call('ZSCORE', KEYS[1], ARGV[4]) or redis.call('ZCARD', KEYS[1]) < tonumber(ARGV[3]) then
  redis.call('ZADD', KEYS[1], tonumber(ARGV[1]) + tonumber(ARGV[2]), ARGV[4])
  redis.call('PEXPIRE', KEYS[1], ARGV[2])
  return 1
end
return 0`;

export class PlacesValkey implements Places {
  constructor(
    private client: Redis,
    private cellule: string,
  ) {}
  private cle = (clientId: string) => `axion:places:${this.cellule}:${clientId}`;
  async prendre(clientId: string, limite: number, proprietaire: string, bailMs: number) {
    const [secondes = 0, micro = 0] = await this.client.time();
    const maintenant = Number(secondes) * 1000 + Math.floor(Number(micro) / 1000);
    return (await this.client.eval(PRENDRE, 1, this.cle(clientId), maintenant, bailMs, limite, proprietaire)) === 1;
  }
  async rendre(clientId: string, proprietaire: string) {
    await this.client.zrem(this.cle(clientId), proprietaire);
  }
}
