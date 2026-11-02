import { randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { OptionsBao } from "../coffre/coffre.js";
import { creerEnveloppe } from "../coffre/enveloppe.js";
import { balayer, sourceColonnesSql, type ElementChiffre, type SourceChiffres } from "./balayage-chiffres.js";
import { contexteChamp, contexteFichier, creerColonnesChiffrees, lierContexte, lireEnveloppeChamp, serialiserEnveloppe } from "./colonnes-chiffrees.js";

// Faux transit avec rotation et réenveloppement. `rewrapFautif` : rend un chiffré qui ne se déchiffre pas en la même donnée.
function creerFaux() {
  let version = 1;
  const donnees = new Map<string, Buffer>();
  const etat = { rewrapFautif: false, rewraps: 0 };
  const rep = (corps: unknown) => new Response(JSON.stringify(corps), { status: 200 });
  const nouveau = (clair: Buffer) => {
    const c = `vault:v${version}:${randomBytes(24).toString("base64")}`;
    donnees.set(c, clair);
    return c;
  };
  const fetchFaux: typeof fetch = async (entree, init) => {
    const chemin = String(entree).replace(/^.*\/v1\//, "");
    const corps = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, string>) : {};
    if (chemin.startsWith("transit/datakey/plaintext/")) {
      const clair = randomBytes(32);
      return rep({ data: { plaintext: clair.toString("base64"), ciphertext: nouveau(clair) } });
    }
    if (chemin.startsWith("transit/decrypt/")) return rep({ data: { plaintext: (donnees.get(corps.ciphertext ?? "") as Buffer).toString("base64") } });
    if (chemin.startsWith("transit/rewrap/")) {
      etat.rewraps++;
      return rep({ data: { ciphertext: nouveau(etat.rewrapFautif ? randomBytes(32) : (donnees.get(corps.ciphertext ?? "") as Buffer)) } });
    }
    if (chemin.endsWith("/rotate")) version++;
    return rep({ data: {} });
  };
  const base: OptionsBao = { url: "http://bao.test", jeton: `jeton-${randomBytes(6).toString("hex")}`, fetch: fetchFaux };
  return { etat, enveloppe: creerEnveloppe(base), colonnes: creerColonnesChiffrees(base) };
}

// Source en mémoire : remplacement par comparaison avec l'ancienne valeur (jamais d'écrasement d'une écriture concurrente).
function creerSource(elements: ElementChiffre[]) {
  const valeurs = new Map(elements.map((e) => [e.id, Buffer.from(e.octets)]));
  const etat = { ecritures: 0, lectures: [] as string[], avantEcriture: undefined as undefined | ((id: string) => void) };
  const source: SourceChiffres = {
    async lire(_t, curseur, taille) {
      const ids = [...valeurs.keys()].sort().filter((i) => curseur === undefined || i > curseur).slice(0, taille);
      const lot = ids.map((id) => ({ id, contexte: elements.find((e) => e.id === id)!.contexte, octets: Uint8Array.from(valeurs.get(id)!) }));
      etat.lectures.push(...ids);
      return { elements: lot, suivant: ids.length === taille ? ids[ids.length - 1] : undefined };
    },
    async remplacer(_t, id, ancien, nouvelle) {
      etat.avantEcriture?.(id);
      if (!valeurs.get(id)?.equals(Buffer.from(ancien))) return false;
      valeurs.set(id, Buffer.from(nouvelle));
      etat.ecritures++;
      return true;
    },
  };
  return { source, valeurs, etat };
}

const T = randomUUID();
const MARQUEUR = (i: number) => `valeur-${i}-${randomBytes(4).toString("hex")}@exemple.fr`;

async function remplir(f: ReturnType<typeof creerFaux>, nbChamps = 5, nbFichiers = 3) {
  const champs: ElementChiffre[] = [];
  const attendus = new Map<string, string>();
  for (let i = 0; i < nbChamps; i++) {
    const contexte = contexteChamp({ colonne: "personnes.courriel_chiffre", idLigne: randomUUID() });
    const clair = MARQUEUR(i);
    champs.push({ id: `c${i}`, contexte, octets: await f.colonnes.chiffrerChamp(T, clair, { colonne: "personnes.courriel_chiffre", idLigne: contexte.split(":")[1] as string }) });
    attendus.set(`c${i}`, clair);
  }
  const fichiers: ElementChiffre[] = [];
  for (let i = 0; i < nbFichiers; i++) {
    const contexte = contexteFichier(`exports/f${i}.bin`);
    const clair = `fichier ${i}`;
    fichiers.push({ id: `f${i}`, contexte, octets: serialiserEnveloppe(await f.enveloppe.chiffrer(T, Buffer.from(clair), contexte)) });
    attendus.set(`f${i}`, clair);
  }
  return { champs, fichiers, attendus };
}

describe("balayage des colonnes et fichiers chiffrés", () => {
  it("[A-243] après rotation, un balayage réenveloppe 100 % des champs et objets d'un client fictif sans modifier leurs chiffrés", async () => {
    const f = creerFaux();
    const { champs, fichiers, attendus } = await remplir(f);
    const avant = new Map([...champs, ...fichiers].map((e) => [e.id, lireEnveloppeChamp(e.octets)]));
    await f.colonnes.pivoterCle(T);
    const c = creerSource(champs);
    const o = creerSource(fichiers);
    const bilan = await balayer({ colonnes: f.colonnes, sources: { champs: c.source, objets: o.source } }, T, { taille: 2 });
    expect(bilan).toMatchObject({ examines: 8, reenveloppes: 8, migres: 0, dejaAJour: 0, conflits: 0, echecs: 0, termine: true });
    for (const [source, ids] of [[c, champs], [o, fichiers]] as const) {
      for (const e of ids) {
        const apres = lireEnveloppeChamp(source.valeurs.get(e.id)!);
        expect(apres.version).toBe(2);
        expect(apres.chiffre.equals(avant.get(e.id)!.chiffre)).toBe(true); // données chiffrées intactes : seule la clé de données est refaite
        expect((await f.enveloppe.dechiffrer(T, apres, e.contexte)).toString()).toBe(attendus.get(e.id));
      }
    }
  });

  it("[A-201] un balayage interrompu reprend sans rien perdre ni refaire ce qui est fait", async () => {
    const f = creerFaux();
    const { champs, attendus } = await remplir(f, 7, 0);
    await f.colonnes.pivoterCle(T);
    const c = creerSource(champs);
    const sources = { champs: c.source };
    const premier = await balayer({ colonnes: f.colonnes, sources }, T, { taille: 2, maxLots: 2 });
    expect(premier).toMatchObject({ examines: 4, reenveloppes: 4, termine: false });
    const second = await balayer({ colonnes: f.colonnes, sources }, T, { taille: 2, reprise: premier.reprise });
    expect(second).toMatchObject({ examines: 3, reenveloppes: 3, termine: true });
    expect(new Set(c.etat.lectures).size).toBe(7);
    expect(c.etat.lectures).toHaveLength(7); // chaque ligne lue une seule fois
    for (const e of champs) expect((await f.enveloppe.dechiffrer(T, lireEnveloppeChamp(c.valeurs.get(e.id)!), e.contexte)).toString()).toBe(attendus.get(e.id));
  });

  it("[A-201] rejouable : un second balayage complet ne réécrit rien", async () => {
    const f = creerFaux();
    const { champs } = await remplir(f, 4, 0);
    await f.colonnes.pivoterCle(T);
    const c = creerSource(champs);
    await balayer({ colonnes: f.colonnes, sources: { champs: c.source } }, T);
    const ecrits = c.etat.ecritures;
    const bilan = await balayer({ colonnes: f.colonnes, sources: { champs: c.source } }, T);
    expect(bilan).toMatchObject({ examines: 4, reenveloppes: 0, dejaAJour: 4, termine: true });
    expect(c.etat.ecritures).toBe(ecrits);
  });

  it("[A-243] un ancien chiffré (contexte en tête du clair) est repris au nouveau format, la donnée reste identique", async () => {
    const f = creerFaux();
    const contexte = contexteChamp({ colonne: "personnes.telephone_chiffre", idLigne: randomUUID() });
    const ancien = serialiserEnveloppe(await f.enveloppe.chiffrer(T, lierContexte(contexte, Buffer.from("+33639980012"))), 1);
    const c = creerSource([{ id: "a", contexte, octets: ancien }]);
    const bilan = await balayer({ colonnes: f.colonnes, sources: { champs: c.source } }, T);
    expect(bilan).toMatchObject({ examines: 1, migres: 1, echecs: 0 });
    const nouveau = c.valeurs.get("a")!;
    expect(nouveau[0]).toBe(2);
    expect((await f.enveloppe.dechiffrer(T, lireEnveloppeChamp(nouveau), contexte)).toString()).toBe("+33639980012");
  });

  it("[A-201] le remplacement n'écrase jamais une écriture concurrente : conflit compté, valeur concurrente intacte", async () => {
    const f = creerFaux();
    const { champs } = await remplir(f, 2, 0);
    await f.colonnes.pivoterCle(T);
    const c = creerSource(champs);
    const concurrente = Buffer.from("autre-valeur-ecrite-entre-temps");
    c.etat.avantEcriture = (id) => { if (id === "c0") c.valeurs.set(id, concurrente); };
    const bilan = await balayer({ colonnes: f.colonnes, sources: { champs: c.source } }, T);
    expect(bilan).toMatchObject({ examines: 2, reenveloppes: 1, conflits: 1, echecs: 0 });
    expect(c.valeurs.get("c0")!.equals(concurrente)).toBe(true);
  });

  it("[A-201] un réenveloppement qui ne relit pas la même donnée n'est jamais écrit", async () => {
    const f = creerFaux();
    const { champs } = await remplir(f, 3, 0);
    const avant = new Map(champs.map((e) => [e.id, Buffer.from(e.octets)]));
    await f.colonnes.pivoterCle(T);
    f.etat.rewrapFautif = true;
    const c = creerSource(champs);
    const bilan = await balayer({ colonnes: f.colonnes, sources: { champs: c.source } }, T);
    expect(bilan).toMatchObject({ examines: 3, reenveloppes: 0, echecs: 3, termine: true });
    expect(c.etat.ecritures).toBe(0);
    for (const [id, v] of avant) expect(c.valeurs.get(id)!.equals(v)).toBe(true);
  });

  it("[A-201] un élément illisible est compté en échec, jamais remplacé, et le balayage continue", async () => {
    const f = creerFaux();
    const { champs } = await remplir(f, 3, 0);
    await f.colonnes.pivoterCle(T);
    const abime: ElementChiffre = { id: "c1", contexte: "personnes.courriel_chiffre:autre-ligne", octets: champs[1]!.octets };
    const c = creerSource([champs[0]!, abime, champs[2]!]);
    const bilan = await balayer({ colonnes: f.colonnes, sources: { champs: c.source } }, T);
    expect(bilan).toMatchObject({ examines: 3, reenveloppes: 2, echecs: 1, termine: true });
    expect(c.valeurs.get("c1")!.equals(Buffer.from(champs[1]!.octets))).toBe(true);
  });

  it("[A-201] le balayage est borné : taille et nombre de lots invalides refusés, aucune lecture", async () => {
    const f = creerFaux();
    const c = creerSource([]);
    for (const mauvais of [{ taille: 0 }, { taille: 10_001 }, { taille: 1.5 }, { maxLots: 0 }]) {
      await expect(balayer({ colonnes: f.colonnes, sources: { champs: c.source } }, T, mauvais)).rejects.toThrow("balayage_invalide");
    }
    expect(c.etat.lectures).toEqual([]);
  });

  it("[A-243] source SQL : identifiants validés, valeurs paramétrées, remplacement par comparaison avec l'ancienne valeur", async () => {
    const requetes: { texte: string; valeurs: unknown[] }[] = [];
    const sql = { query: async (texte: string, valeurs: unknown[] = []) => (requetes.push({ texte, valeurs }), { rows: [{ id: "1" }] }) };
    for (const [table, colonnes] of [["personnes; DROP TABLE x", ["a"]], ["commun.personnes", ["a b"]], ["commun.personnes", []]] as const) {
      expect(() => sourceColonnesSql(sql, table, [...colonnes])).toThrow("balayage_invalide");
    }
    const source = sourceColonnesSql(sql, "commun.personnes", ["courriel_chiffre"]);
    expect(await source.remplacer(T, "courriel_chiffre:0b1c2d3e-0000-4000-8000-000000000001", Uint8Array.of(1), Uint8Array.of(2))).toBe(true);
    expect(requetes[0]?.texte).toMatch(/UPDATE commun\.personnes SET courriel_chiffre = \$3 WHERE id = \$1::uuid AND courriel_chiffre = \$2/);
    expect(requetes[0]?.texte).not.toMatch(/DELETE|TRUNCATE|DROP/i);
    await expect(source.remplacer(T, "autre_colonne:x", Uint8Array.of(1), Uint8Array.of(2))).rejects.toThrow("balayage_invalide");
  });
});
