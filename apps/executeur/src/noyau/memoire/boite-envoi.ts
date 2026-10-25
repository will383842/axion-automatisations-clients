import type { Bail, BoiteEnvoi, Intention } from "../ports.ts";

export class BoiteEnMemoire implements BoiteEnvoi {
  #parCle = new Map<string, Intention>();
  async ecrire(i: Omit<Intention, "etat" | "bail">, bail: Bail, maintenant: number) {
    const existante = this.#parCle.get(i.cle);
    if (!existante) {
      const nouvelle: Intention = { ...i, etat: "ecrite", bail };
      this.#parCle.set(i.cle, nouvelle);
      return { intention: { ...nouvelle }, creee: true, occupee: false };
    }
    const occupee = existante.etat === "ecrite" && existante.bail !== undefined && existante.bail.proprietaire !== bail.proprietaire && existante.bail.jusqua > maintenant;
    if (existante.etat === "ecrite" && !occupee) existante.bail = bail;
    return { intention: { ...existante }, creee: false, occupee };
  }
  async lire(cle: string) {
    const i = this.#parCle.get(cle);
    return i && { ...i };
  }
  async marquerFaite(cle: string, proprietaire: string) {
    return this.#changer(cle, proprietaire, "faite");
  }
  async marquerATrancher(cle: string, proprietaire: string) {
    return this.#changer(cle, proprietaire, "a_trancher");
  }
  async liberer(cle: string, proprietaire: string) {
    const i = this.#parCle.get(cle);
    if (i?.bail?.proprietaire === proprietaire) delete i.bail;
  }
  toutes(): Intention[] {
    return [...this.#parCle.values()].map((i) => ({ ...i }));
  }
  #changer(cle: string, proprietaire: string, etat: "faite" | "a_trancher") {
    const i = this.#parCle.get(cle);
    if (!i || i.etat !== "ecrite" || i.bail?.proprietaire !== proprietaire) return false;
    i.etat = etat;
    return true;
  }
}
