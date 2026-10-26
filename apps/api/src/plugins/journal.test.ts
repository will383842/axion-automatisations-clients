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

  it("[A-005] le masqueur cache un secret à guillemet et à barre oblique recopié dans un message qui contient déjà du JSON (double échappement)", () => {
    const m = creerMasqueur();
    const secret = `${MARQUEUR}"ab\\cd`;
    m.ajouter(secret);
    const message = `réponse du service : ${JSON.stringify({ k: secret })}`;
    const ligne = JSON.stringify({ msg: message });
    expect(ligne).not.toContain(secret);
    const sortie = m.masquer(ligne);
    expect(sortie).toContain("[masqué]");
    expect(sortie).not.toContain(MARQUEUR);
    expect(sortie).not.toContain("ab");
  });

  it("[A-005] le masqueur cache la forme de formulaire (espace → +), dans un message et dans l'adresse journalisée", async () => {
    const m = creerMasqueur();
    const secret = `${MARQUEUR} val+x`;
    m.ajouter(secret);
    const formulaire = new URLSearchParams({ q: secret }).toString();
    expect(formulaire).toContain("+val%2Bx");
    expect(m.masquer(formulaire)).toBe("q=[masqué]");
    const lignes: string[] = [];
    const serveur = construireServeur({ journal: creerFluxJournal(m, (l) => lignes.push(l)) });
    serveur.get("/p", async () => {
      throw new Error("échec");
    });
    await serveur.inject({ method: "GET", url: `/p?${formulaire}` });
    await serveur.close();
    const sortie = lignes.join("");
    expect(sortie).toContain("[masqué]");
    expect(sortie).not.toContain(MARQUEUR);
    expect(sortie).not.toContain("val%2Bx");
  });

  it.each(["a", "ab", "abc", "utilisateur:"])("[A-005] le masqueur cache le base64 et le base64url d'une valeur composée (préfixe « %s », secret non aligné sur 3 octets)", (prefixe) => {
    for (const secret of [`${MARQUEUR}-12`, `${MARQUEUR}-123`, `${MARQUEUR}-1234`]) {
      const m = creerMasqueur();
      m.ajouter(secret);
      for (const codage of ["base64", "base64url"] as const) {
        const entete = `Basic ${Buffer.from(`${prefixe}${secret}`).toString(codage)}`;
        const milieu = entete.slice(6 + 4, -4); // sans les caractères de bord, qui dépendent du voisin
        expect(m.masquer(entete)).not.toContain(milieu);
        expect(m.masquer(entete)).toContain("[masqué]");
      }
    }
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
