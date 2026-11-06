import { UNE_JOURNEE_MS } from "./pause-sure.ts";

// Réglages gardés min(durée renvoyée par la console, 24 h), sur une horloge monotone ; vidé à la réception d'une poussée.
export class CacheReglages<T> {
  #m = new Map<string, { valeur: T; jusqua: number }>();
  constructor(private maintenantMs: () => number) {}
  async lire(cle: string, charger: () => Promise<{ valeur: T; dureeSecondes: number }>): Promise<T> {
    const present = this.#m.get(cle);
    if (present && this.maintenantMs() < present.jusqua) return present.valeur;
    const { valeur, dureeSecondes } = await charger();
    const duree = Math.min(Math.max(0, Number.isFinite(dureeSecondes) ? dureeSecondes * 1000 : 0), UNE_JOURNEE_MS);
    this.#m.set(cle, { valeur, jusqua: this.maintenantMs() + duree });
    return valeur;
  }
  vider(cle?: string): void {
    if (cle === undefined) this.#m.clear();
    else this.#m.delete(cle);
  }
}
