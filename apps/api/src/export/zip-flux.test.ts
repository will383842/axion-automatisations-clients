import { describe, expect, it } from "vitest";
import { ecrireZip, lireZip, type EntreeZip } from "./zip-flux.js";

const DATE = new Date("2026-11-02T10:00:00Z");
async function zipDe(entrees: EntreeZip[]): Promise<Buffer> {
  const morceaux: Buffer[] = [];
  for await (const m of ecrireZip(entrees, DATE)) morceaux.push(Buffer.from(m));
  return Buffer.concat(morceaux);
}
async function* enMorceaux(texte: string) {
  for (let i = 0; i < texte.length; i += 7) yield Buffer.from(texte.slice(i, i + 7));
}

describe("ZIP en flux", () => {
  it("[A-252] un ZIP écrit en flux se relit à l'identique, noms accentués compris", async () => {
    const zip = await zipDe([
      { nom: "donnees/commun/personnes.csv", contenu: enMorceaux("id,nom\r\n1,Élodie\r\n") },
      { nom: "fichiers/devis.pdf", contenu: Buffer.from([0, 1, 2, 255]) },
      { nom: "vide.txt", contenu: Buffer.alloc(0) },
    ]);
    const lu = lireZip(zip);
    expect([...lu.keys()]).toEqual(["donnees/commun/personnes.csv", "fichiers/devis.pdf", "vide.txt"]);
    expect(lu.get("donnees/commun/personnes.csv")!.toString("utf8")).toBe("id,nom\r\n1,Élodie\r\n");
    expect([...lu.get("fichiers/devis.pdf")!]).toEqual([0, 1, 2, 255]);
    expect(lu.get("vide.txt")!.length).toBe(0);
  });

  it("[A-252] un nom dangereux ou en double est refusé avant toute écriture", async () => {
    for (const nom of ["../secret", "/abs", "a/../b", "a\\b", "a//b", "", "a\u0000b", "./a"]) {
      await expect(zipDe([{ nom, contenu: Buffer.from("x") }]), nom).rejects.toThrow("nom_invalide");
    }
    await expect(zipDe([{ nom: "a", contenu: Buffer.from("x") }, { nom: "a", contenu: Buffer.from("y") }])).rejects.toThrow("nom_en_double");
  });

  it("[B-374] un octet changé dans un ZIP est vu à la relecture (somme CRC)", async () => {
    const zip = await zipDe([{ nom: "a.txt", contenu: Buffer.from("contenu intact ".repeat(20)) }]);
    // Méthode « stocké » impossible à deviner : on abîme le milieu des données compressées.
    const abime = Buffer.from(zip);
    abime[40] = abime[40]! ^ 0xff;
    expect(() => lireZip(abime)).toThrow();
  });
});
