import { describe, expect, it } from "vitest";
import { Dedoublonneur } from "./dedoublonner.ts";
import { classerLigne, type ListesExclusion } from "./exclusion.ts";
import { lireLignes, ErreurImport } from "./lecteur.ts";

// Dettes MOYEN de l'audit de #205 : colonne d'adresse partagée entre exclusion et dédoublonnage (adresses fictives).
async function* source(m: string[]): AsyncGenerator<string> { for (const x of m) yield x; }
const aucune: ListesExclusion = { client: async () => false, plateforme: async () => false };

describe("colonne d'adresse (dettes de l'audit de #205)", () => {
  it("[A-273] deux lignes de même adresse sous l'en-tête « E-mail » ne donnent qu'un contact", async () => {
    const d = new Dedoublonneur(async () => false);
    expect(await d.estDoublon({ "E-mail": "a@exemple.fr" })).toBe(false);
    expect(await d.estDoublon({ "E-mail": " A@Exemple.fr " })).toBe(true);
    const c = new Dedoublonneur(async () => false);
    expect(await c.estDoublon({ Courriel: "b@exemple.fr" })).toBe(false);
    expect(await c.estDoublon({ Courriel: "b@exemple.fr" })).toBe(true);
  });
  it("[C-633] un fichier qui a plus d'une colonne d'adresse reconnue est refusé", async () => {
    const lire = async () => { for await (const l of lireLignes(source(["Email,Email 2\na@exemple.fr,stop@exemple.fr"]))) await classerLigne(l, aucune); };
    await expect(lire()).rejects.toMatchObject({ code: "colonne_adresse_multiple" });
    await expect(lire()).rejects.toBeInstanceOf(ErreurImport);
    await expect(classerLigne({ Courriel: "a@exemple.fr", email: "b@exemple.fr" }, aucune)).rejects.toMatchObject({ code: "colonne_adresse_multiple" });
  });
  it("[C-633] une colonne d'adresse unique reste contrôlée contre les deux listes", async () => {
    const stop: ListesExclusion = { client: async () => true, plateforme: async () => false };
    expect(await classerLigne({ "E-mail": "a@exemple.fr" }, stop)).toBe("exclue_client");
  });
});
