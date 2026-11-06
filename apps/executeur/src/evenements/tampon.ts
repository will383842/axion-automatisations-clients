import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Evenement } from "@axion-auto/contrats/src/c4/evenements-executeur.ts";

// Tampon des événements : en mémoire ET dans un fichier du dossier temporaire de la cellule (survit à un redémarrage).
// Il ne contient que des identifiants, des entiers et des codes fermés (schéma strict de C4). Borné : au-delà, l'ajout est refusé et compté, jamais un effacement.
export class TamponEvenements {
  #liste: Evenement[] = [];
  readonly #fichier: string;
  refuses = 0;
  constructor(
    dossier: string,
    private o: { maxEvenements: number },
  ) {
    mkdirSync(dossier, { recursive: true });
    this.#fichier = join(dossier, "evenements.jsonl");
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
  // Retire les n premiers (ceux d'un paquet accepté) et réécrit le fichier d'un coup.
  retirer(n: number): void {
    this.#liste = this.#liste.slice(n);
    const temporaire = `${this.#fichier}.tmp`;
    writeFileSync(temporaire, this.#liste.map((e) => `${JSON.stringify(e)}\n`).join(""));
    renameSync(temporaire, this.#fichier);
  }
}
