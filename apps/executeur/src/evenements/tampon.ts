import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Evenement } from "@axion-auto/contrats/src/c4/evenements-executeur.ts";

export const QUARANTAINE_MAX = 5000;

// Tampon des événements : en mémoire ET dans un fichier du dossier temporaire de la cellule (survit à un redémarrage).
// Il ne contient que des identifiants, des entiers et des codes fermés (schéma strict de C4). Borné : au-delà, l'ajout est refusé et compté, jamais un effacement.
export class TamponEvenements {
  #liste: Evenement[] = [];
  readonly #fichier: string;
  refuses = 0;
  quarantaine = 0; // lots mis à part depuis le démarrage (compte d'événements)
  readonly #fichierQuarantaine: string;
  constructor(
    dossier: string,
    private o: { maxEvenements: number },
  ) {
    mkdirSync(dossier, { recursive: true });
    this.#fichier = join(dossier, "evenements.jsonl");
    this.#fichierQuarantaine = join(dossier, "quarantaine.jsonl");
    try {
      for (const ligne of readFileSync(this.#fichier, "utf8").split("\n")) {
        if (!ligne) continue;
        const e = Evenement.safeParse(JSON.parse(ligne));
        if (e.success) this.#liste.push(e.data); // une ligne abîmée par une coupure est ignorée
      }
    } catch {
      // fichier absent : tampon vide
    }
  }
  evenements(): readonly Evenement[] {
    return this.#liste;
  }
  ajouter(e: Evenement): boolean {
    if (this.#liste.length >= this.o.maxEvenements) {
      this.refuses++;
      return false;
    }
    this.#liste.push(e);
    appendFileSync(this.#fichier, `${JSON.stringify(e)}\n`);
    return true;
  }
  // Retire les événements du lot par identité (pas par compte : d'autres ont pu arriver ou partir entre-temps) et réécrit le fichier d'un coup.
  retirer(lot: readonly Evenement[]): void {
    const partis = new Set<Evenement>(lot);
    this.#liste = this.#liste.filter((e) => !partis.has(e));
    const temporaire = `${this.#fichier}.tmp`;
    writeFileSync(temporaire, this.#liste.map((e) => `${JSON.stringify(e)}\n`).join(""));
    renameSync(temporaire, this.#fichier);
  }
  // Refus définitif de la console : le lot sort du tampon pour ne pas bloquer les suivants. Fichier borné (les plus anciens sont écartés), compté, identifiants seuls.
  mettreAPart(lot: readonly Evenement[], max = QUARANTAINE_MAX): void {
    this.quarantaine += lot.length;
    const gardes = [...this.enQuarantaine(), ...lot].slice(-max);
    writeFileSync(this.#fichierQuarantaine, gardes.map((e) => `${JSON.stringify(e)}\n`).join(""));
    this.retirer(lot);
  }
  enQuarantaine(): Evenement[] {
    try {
      return readFileSync(this.#fichierQuarantaine, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Evenement);
    } catch {
      return [];
    }
  }
}
