import { randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ErreurCoffre, type OptionsBao } from "../coffre/coffre.js";
import { creerEnveloppe } from "../coffre/enveloppe.js";
import { contexteFichier, creerColonnesChiffrees, lierContexte, lireEnveloppeChamp, serialiserEnveloppe } from "../donnees/colonnes-chiffrees.js";
import { creerFichiersClient, type PortFichiers } from "./fichiers-client.js";

// Faux transit minimal (clés de données seulement) et faux stockage : un « compartiment » par client, clés d'essai générées à l'exécution.
function monter() {
  const cles = new Set<string>();
  const donnees = new Map<string, { nom: string; clair: Buffer }>();
  const etat = { scelle: false, appels: [] as string[], clairs: [] as Buffer[] };
  const rep = (corps: unknown, statut = 200) => new Response(JSON.stringify(corps), { status: statut });
  const bao: typeof fetch = async (entree, init) => {
    const chemin = String(entree).replace(/^.*\/v1\//, "");
    etat.appels.push(`${init?.method} ${chemin}`);
    if (etat.scelle) return new Response("Vault is sealed", { status: 503 });
    const corps = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, string>) : {};
    let m: RegExpExecArray | null;
    if ((m = /^transit\/keys\/([a-z0-9-]+)(?:\/config)?$/.exec(chemin))) {
      if (init?.method === "DELETE") cles.delete(m[1] as string);
      return rep({ data: {} });
    }
    if ((m = /^transit\/(datakey\/plaintext|decrypt)\/([a-z0-9-]+)$/.exec(chemin))) {
      const nom = m[2] as string;
      if (!cles.has(nom)) return rep({}, 404);
      if (m[1] === "decrypt") {
        const connu = donnees.get(corps.ciphertext ?? "");
        return !connu || connu.nom !== nom ? rep({}, 400) : rep({ data: { plaintext: connu.clair.toString("base64") } });
      }
      const clair = randomBytes(32);
      const c = `vault:v1:${randomBytes(24).toString("base64")}`;
      etat.clairs.push(clair);
      donnees.set(c, { nom, clair });
      return rep({ data: { plaintext: clair.toString("base64"), ciphertext: c } });
    }
    return rep({}, 404);
  };
  const objets = new Map<string, Uint8Array>();
  const stockage: PortFichiers = {
    async deposer(t, cle, o) { objets.set(`${t}/${cle}`, Uint8Array.from(o)); },
    async lire(t, cle) { return objets.get(`${t}/${cle}`); },
  };
  const base: OptionsBao & { observerCle: (b: Buffer) => void } = { url: "http://bao.test", jeton: `jeton-${randomBytes(6).toString("hex")}`, fetch: bao, observerCle: () => undefined };
  return {
    etat, objets, stockage,
    creerClient: (t: string) => void cles.add(`cli-${t}`),
    enveloppe: creerEnveloppe(base),
    fichiers: creerFichiersClient({ stockage, enveloppe: creerEnveloppe(base) }),
    colonnes: creerColonnesChiffrees(base),
  };
}
const A = randomUUID();
const B = randomUUID();
const CONTENU = Buffer.from(`devis-${randomBytes(8).toString("hex")} Boulangerie Rivoire, fichier fictif`);
// Boulangerie Rivoire : entreprise inventée, permise par CLAUDE.md §2 (ce n'est pas un vrai client).
const CTX = { colonne: "personnes.courriel_chiffre", idLigne: randomUUID() };
const refus = async (p: Promise<unknown>, code?: string) => {
  const e = await p.then(() => undefined, (x: unknown) => x);
  expect(e).toBeInstanceOf(ErreurCoffre);
  if (code) expect((e as ErreurCoffre).code).toBe(code);
};

describe("fichiers du compartiment chiffrés par la clé du client", () => {
  it("[A-201] un fichier déposé est chiffré dans le compartiment cli-<id>", async () => {
    const m = monter();
    m.creerClient(A);
    await m.fichiers.deposerFichier(A, "exports/devis.pdf", CONTENU);
    // Lecture directe par le stockage, sans déchiffrement : on n'obtient qu'un chiffré.
    const brut = Buffer.from((await m.stockage.lire(A, "exports/devis.pdf")) as Uint8Array);
    expect(brut.length).toBeGreaterThan(CONTENU.length);
    expect(brut.includes(CONTENU.subarray(0, 12))).toBe(false);
    for (const clair of m.etat.clairs) expect(brut.includes(clair)).toBe(false);
    expect((await m.fichiers.lireFichier(A, "exports/devis.pdf"))?.equals(CONTENU)).toBe(true);
    expect(await m.fichiers.lireFichier(A, "exports/absent.pdf")).toBeUndefined();
  });

  it("[A-201] @isolation un objet de A recopié dans le compartiment de B ne se lit pas", async () => {
    const m = monter();
    m.creerClient(A);
    m.creerClient(B);
    await m.fichiers.deposerFichier(A, "suivi/note.txt", CONTENU);
    await m.stockage.deposer(B, "suivi/note.txt", (await m.stockage.lire(A, "suivi/note.txt")) as Uint8Array);
    await refus(m.fichiers.lireFichier(B, "suivi/note.txt"));
  });

  it("[A-201] @isolation un objet déplacé sous une autre clé du même compartiment ne se lit pas", async () => {
    const m = monter();
    m.creerClient(A);
    await m.fichiers.deposerFichier(A, "exports/devis.pdf", CONTENU);
    await m.fichiers.deposerFichier(A, "exports/autre.pdf", Buffer.from("autre fichier fictif"));
    // Un acteur du stockage recopie le chiffré du devis sur l'autre clé : le chiffré est valide pour ce client, mais pas pour cet objet.
    await m.stockage.deposer(A, "exports/autre.pdf", (await m.stockage.lire(A, "exports/devis.pdf")) as Uint8Array);
    await refus(m.fichiers.lireFichier(A, "exports/autre.pdf"), "dechiffrement_impossible");
    expect((await m.fichiers.lireFichier(A, "exports/devis.pdf"))?.equals(CONTENU)).toBe(true);
  });

  it("[A-201] @isolation un champ chiffré ne se lit pas comme fichier, ni un fichier comme champ (séparation champ / fichier)", async () => {
    const m = monter();
    m.creerClient(A);
    const champ = await m.colonnes.chiffrerChamp(A, "marc@exemple.fr", CTX);
    await m.stockage.deposer(A, `${CTX.colonne}:${CTX.idLigne}`, champ);
    await refus(m.fichiers.lireFichier(A, `${CTX.colonne}:${CTX.idLigne}`), "dechiffrement_impossible");
    await m.fichiers.deposerFichier(A, `${CTX.colonne}:${CTX.idLigne}`, Buffer.from("marc@exemple.fr"));
    const fichier = (await m.stockage.lire(A, `${CTX.colonne}:${CTX.idLigne}`)) as Uint8Array;
    await refus(m.colonnes.dechiffrerChamp(A, fichier, CTX), "dechiffrement_impossible");
  });

  it("[A-243] @isolation le contexte de l'objet est dans les données associées (AAD) : déchiffrer sans lui ou avec la clé d'un autre objet est refusé", async () => {
    const m = monter();
    m.creerClient(A);
    await m.fichiers.deposerFichier(A, "exports/a.bin", CONTENU);
    const e = lireEnveloppeChamp(m.objets.get(`${A}/exports/a.bin`)!);
    expect((await m.enveloppe.dechiffrer(A, e, contexteFichier("exports/a.bin"))).equals(CONTENU)).toBe(true);
    await refus(m.enveloppe.dechiffrer(A, e, contexteFichier("exports/b.bin")), "dechiffrement_impossible");
    await refus(m.enveloppe.dechiffrer(A, e), "dechiffrement_impossible");
  });

  it("[A-243] un ancien objet (format 1, contexte en tête du clair) se lit encore pendant la transition", async () => {
    const m = monter();
    m.creerClient(A);
    m.objets.set(`${A}/exports/vieux.bin`, serialiserEnveloppe(await m.enveloppe.chiffrer(A, lierContexte(contexteFichier("exports/vieux.bin"), CONTENU)), 1));
    expect((await m.fichiers.lireFichier(A, "exports/vieux.bin"))!.equals(CONTENU)).toBe(true);
    await refus(m.fichiers.lireFichier(A, "exports/vieux.bin").then(() => { m.objets.set(`${A}/exports/autre.bin`, m.objets.get(`${A}/exports/vieux.bin`)!); return m.fichiers.lireFichier(A, "exports/autre.bin"); }), "dechiffrement_impossible");
  });

  it("[A-244] le compartiment et les colonnes utilisent la même clé du client, sans clé en clair dans l'objet", async () => {
    const m = monter();
    m.creerClient(A);
    await m.colonnes.chiffrerChamp(A, "marc@exemple.fr", CTX);
    await m.fichiers.deposerFichier(A, "exports/a.bin", CONTENU);
    const demandes = m.etat.appels.filter((a) => a.includes("datakey"));
    expect(demandes).toEqual([`POST transit/datakey/plaintext/cli-${A}`, `POST transit/datakey/plaintext/cli-${A}`]);
    const brut = Buffer.from((await m.stockage.lire(A, "exports/a.bin")) as Uint8Array);
    expect(brut.toString("latin1")).toContain("vault:v1:");
  });

  it("[A-244] pas de clé du client : refus, rien n'est déposé, aucun repli", async () => {
    const m = monter();
    m.creerClient(A);
    await refus(m.fichiers.deposerFichier(B, "exports/b.bin", CONTENU));
    await refus(m.fichiers.deposerFichier("systeme", "exports/b.bin", CONTENU), "tenant_invalide");
    expect(m.objets.size).toBe(0);
  });

  it("[A-245] après destruction de la clé, les fichiers sont illisibles (imitation)", async () => {
    const m = monter();
    m.creerClient(A);
    await m.fichiers.deposerFichier(A, "exports/devis.pdf", CONTENU);
    expect((await m.fichiers.lireFichier(A, "exports/devis.pdf"))?.equals(CONTENU)).toBe(true);
    await m.enveloppe.detruireCleClient(A, `detruire-${A}`);
    await refus(m.fichiers.lireFichier(A, "exports/devis.pdf"));
  });

  it("[C-011] coffre scellé : erreur coffre_scelle, rien de déposé en clair", async () => {
    const m = monter();
    m.creerClient(A);
    await m.fichiers.deposerFichier(A, "exports/devis.pdf", CONTENU);
    m.etat.scelle = true;
    await refus(m.fichiers.deposerFichier(A, "exports/autre.pdf", CONTENU), "coffre_scelle");
    await refus(m.fichiers.lireFichier(A, "exports/devis.pdf"), "coffre_scelle");
    expect(m.objets.has(`${A}/exports/autre.pdf`)).toBe(false);
  });
});
