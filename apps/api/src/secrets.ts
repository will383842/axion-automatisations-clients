// Lecture des secrets : une interface seulement. L'implémentation OpenBao vient avec T1A-06.
export interface LecteurSecrets {
  lire(nom: string): Promise<string>;
}

export class LecteurSecretsMemoire implements LecteurSecrets {
  readonly #valeurs: ReadonlyMap<string, string>;
  constructor(valeurs: Record<string, string>) { this.#valeurs = new Map(Object.entries(valeurs)); }
  async lire(nom: string): Promise<string> {
    const valeur = this.#valeurs.get(nom);
    if (valeur === undefined) throw new Error(`secret introuvable : ${nom}`);
    return valeur;
  }
}
