import { describe, expect, it, vi } from "vitest";
import { construireServeur } from "../serveur.js";
import { creerFluxJournal, creerMasqueur } from "./journal.js";

const MARQUEUR = "MARQUEUR-ESSAI-7f3a91c2d4b8";

describe("masquage des secrets dans le journal de l'API", () => {
  it("[A-005] le masqueur cache la valeur brute, en JSON, en adresse et en base64", () => {
    const m = creerMasqueur();
    const valeur = `${MARQUEUR} é/+"x`;
    m.ajouter(valeur);
    const formes = [valeur, JSON.stringify(valeur).slice(1, -1), encodeURIComponent(valeur), Buffer.from(valeur).toString("base64"), Buffer.from(valeur).toString("base64url")];
    for (const f of formes) expect(m.masquer(`avant ${f} après`)).toBe("avant [masqué] après");
  });

  it("[A-005] le masqueur ignore une valeur vide et laisse le reste du texte intact", () => {
    const m = creerMasqueur();
    m.ajouter("");
    expect(m.masquer("rien à cacher")).toBe("rien à cacher");
  });

  it("[A-005] le flux du journal masque la ligne entière avant de l'écrire", () => {
    const m = creerMasqueur();
    m.ajouter(MARQUEUR);
    const lignes: string[] = [];
    creerFluxJournal(m, (l) => lignes.push(l)).write(`{"msg":"x ${MARQUEUR}"}\n`);
    expect(lignes.join("")).not.toContain(MARQUEUR);
    expect(lignes.join("")).toContain("[masqué]");
  });

  it("[A-005] le journal de l'API ne contient jamais la valeur rangée (marqueur unique cherché dans la sortie)", async () => {
    const m = creerMasqueur();
    m.ajouter(MARQUEUR);
    const lignes: string[] = [];
    const serveur = construireServeur({ journal: creerFluxJournal(m, (l) => lignes.push(l)) });
    serveur.get("/piege", async () => {
      throw new Error(`échec avec ${MARQUEUR}`);
    });
    await serveur.inject({ method: "GET", url: `/piege?x=${encodeURIComponent(MARQUEUR)}` });
    await serveur.close();
    const sortie = lignes.join("");
    expect(sortie).toContain("erreur interne"); // le journal marche vraiment
    expect(sortie).not.toContain(MARQUEUR);
  });

  it("[A-005] sans flux fourni, le serveur n'écrit aucun journal (interrupteur fermé)", async () => {
    const ecrit = vi.spyOn(process.stdout, "write");
    const serveur = construireServeur();
    serveur.get("/piege", async () => {
      throw new Error("échec");
    });
    await serveur.inject({ method: "GET", url: "/piege" });
    await serveur.close();
    expect(ecrit).not.toHaveBeenCalled();
    ecrit.mockRestore();
  });
});
