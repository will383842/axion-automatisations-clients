import { randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ErreurCoffre, type OptionsBao } from "./coffre.js";
import { creerEnveloppe } from "./enveloppe.js";

// Faux transit minimal : une clé par client, clés de données générées à l'exécution.
function monter() {
  const donnees = new Map<string, Buffer>();
  const appels: string[] = [];
  const rep = (corps: unknown) => new Response(JSON.stringify(corps), { status: 200 });
  const fetchFaux: typeof fetch = async (entree, init) => {
    const chemin = String(entree).replace(/^.*\/v1\//, "");
    appels.push(`${init?.method} ${chemin}`);
    const corps = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, string>) : {};
    if (/^transit\/datakey\/plaintext\//.test(chemin)) {
      const clair = randomBytes(32);
      const c = `vault:v1:${randomBytes(24).toString("base64")}`;
      donnees.set(c, clair);
      return rep({ data: { plaintext: clair.toString("base64"), ciphertext: c } });
    }
    if (/^transit\/decrypt\//.test(chemin)) return rep({ data: { plaintext: (donnees.get(corps.ciphertext ?? "") ?? randomBytes(32)).toString("base64") } });
    return rep({ data: {} });
  };
  const base: OptionsBao = { url: "http://bao.test", jeton: `jeton-${randomBytes(6).toString("hex")}`, fetch: fetchFaux };
  return { appels, enveloppe: creerEnveloppe(base) };
}
const A = randomUUID();
const MESSAGE = Buffer.from("message fictif");

describe("enveloppe : contexte lié au chiffré dans les données associées", () => {
  it("[A-243] @isolation un chiffré avec contexte ne se déchiffre qu'avec le même contexte (ni un autre, ni aucun)", async () => {
    const { enveloppe } = monter();
    const e = await enveloppe.chiffrer(A, MESSAGE, "personnes.courriel_chiffre:ligne-1");
    expect((await enveloppe.dechiffrer(A, e, "personnes.courriel_chiffre:ligne-1")).equals(MESSAGE)).toBe(true);
    for (const autre of ["personnes.courriel_chiffre:ligne-2", "personnes.telephone_chiffre:ligne-1", "fichier:exports/a.bin", undefined]) {
      await expect(enveloppe.dechiffrer(A, e, autre)).rejects.toMatchObject({ code: "dechiffrement_impossible" });
    }
  });
  it("[A-243] sans contexte, le comportement d'avant est gardé (lecture des anciens chiffrés pendant la transition)", async () => {
    const { enveloppe } = monter();
    const e = await enveloppe.chiffrer(A, MESSAGE);
    expect((await enveloppe.dechiffrer(A, e)).equals(MESSAGE)).toBe(true);
    await expect(enveloppe.dechiffrer(A, e, "x:y")).rejects.toBeInstanceOf(ErreurCoffre);
  });
  it("[A-243] un contexte vide ou qui n'est pas du texte est refusé avant tout appel au coffre", async () => {
    const { enveloppe, appels } = monter();
    for (const mauvais of ["", 12, null] as unknown as string[]) await expect(enveloppe.chiffrer(A, MESSAGE, mauvais)).rejects.toBeInstanceOf(Error);
    expect(appels).toEqual([]);
  });
});
