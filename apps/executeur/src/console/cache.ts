import { UNE_JOURNEE_MS } from "./pause-sure.ts";

// Réglages gardés min(durée renvoyée par la console, 24 h), sur une horloge monotone ; vidé à la réception d'une poussée.
export class CacheReglages<T> {
  #m = new Map<string, { valeur: T; jusqua: number }>();
  // Génération par clé et globale : une poussée reçue pendant un chargement empêche d'écrire la valeur lue avant elle.
  #gen = new Map<string, number>();
  #genGlobale = 0;
  #generation = (cle: string) => `${this.#genGlobale}:${this.#gen.get(cle) ?? 0}`;
  constructor(private maintenantMs: () => number) {}
  async lire(cle: string, charger: () => Promise<{ valeur: T; dureeSecondes: number }>): Promise<T> {
    const present = this.#m.get(cle);
    if (present && this.maintenantMs() < present.jusqua) return present.valeur;
    const avant = this.#generation(cle);
    const { valeur, dureeSecondes } = await charger();
    if (this.#generation(cle) !== avant) return valeur; // vidé pendant le chargement : servi à l'appelant, jamais gardé
    const duree = Math.min(Math.max(0, Number.isFinite(dureeSecondes) ? dureeSecondes * 1000 : 0), UNE_JOURNEE_MS);
    this.#m.set(cle, { valeur, jusqua: this.maintenantMs() + duree });
    return valeur;
  }
  vider(cle?: string): void {
    if (cle === undefined) {
      this.#genGlobale++;
      this.#m.clear();
    } else {
      this.#gen.set(cle, (this.#gen.get(cle) ?? 0) + 1);
      this.#m.delete(cle);
    }
  }
}
