import { randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ErreurCoffre, type OptionsBao } from "../coffre/coffre.js";
import { creerEnveloppe } from "../coffre/enveloppe.js";
import { creerColonnesChiffrees } from "../donnees/colonnes-chiffrees.js";
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

  it("[A-244] le compartiment et les colonnes utilisent la même clé du client, sans clé en clair dans l'objet", async () => {
    const m = monter();
    m.creerClient(A);
    await m.colonnes.chiffrerChamp(A, "marc@exemple.fr");
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
