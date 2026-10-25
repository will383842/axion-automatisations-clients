import type { BoiteEnvoi, Intention } from "../ports.ts";

export class BoiteEnMemoire implements BoiteEnvoi {
  #parCle = new Map<string, Intention>();
  async ecrire(i: Omit<Intention, "etat">) {
    const existante = this.#parCle.get(i.cle);
    if (existante) return { intention: { ...existante }, creee: false };
    const nouvelle: Intention = { ...i, etat: "ecrite" };
    this.#parCle.set(i.cle, nouvelle);
    return { intention: { ...nouvelle }, creee: true };
  }
  async lire(cle: string) {
    const i = this.#parCle.get(cle);
    return i && { ...i };
  }
  async marquerFaite(cle: string) {
    this.#changer(cle, "faite");
  }
  async marquerATrancher(cle: string) {
    this.#changer(cle, "a_trancher");
  }
  toutes(): Intention[] {
    return [...this.#parCle.values()].map((i) => ({ ...i }));
  }
  #changer(cle: string, etat: Intention["etat"]) {
    const i = this.#parCle.get(cle);
    if (!i) throw new Error("intention inconnue");
    i.etat = etat;
  }
}
