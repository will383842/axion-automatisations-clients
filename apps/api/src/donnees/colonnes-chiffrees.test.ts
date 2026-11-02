import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ErreurCoffre, type OptionsBao } from "../coffre/coffre.js";
import { creerEnveloppe } from "../coffre/enveloppe.js";
import { creerColonnesChiffrees, lireEnveloppeChamp, normaliserEmail, normaliserTelephone } from "./colonnes-chiffrees.js";

// Faux OpenBao (moteur transit) : clés par client, versions, clés de données, HMAC. Tout est généré à l'exécution.
function creerFauxTransit() {
  const cles = new Map<string, { version: number; secret: Buffer }>();
  const donnees = new Map<string, { nom: string; clair: Buffer }>();
  const etat = { scelle: false, appels: [] as string[], clairs: [] as Buffer[] };
  const rep = (corps: unknown, statut = 200) => new Response(JSON.stringify(corps), { status: statut });
  const chiffreDe = (nom: string, clair: Buffer) => {
    const c = `vault:v${cles.get(nom)?.version}:${randomBytes(24).toString("base64")}`;
    donnees.set(c, { nom, clair });
    return c;
  };
  const fetchFaux: typeof fetch = async (entree, init) => {
    const chemin = String(entree).replace(/^.*\/v1\//, "");
    etat.appels.push(`${init?.method} ${chemin}`);
    if (etat.scelle) return new Response("Vault is sealed", { status: 503 });
    const corps = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, string>) : {};
    let m: RegExpExecArray | null;
    if ((m = /^transit\/keys\/([a-z0-9-]+)(?:\/(rotate|config))?$/.exec(chemin))) {
      const nom = m[1] as string;
      if (init?.method === "DELETE") return cles.delete(nom) ? rep(undefined, 204) : rep({}, 404);
      if (m[2] === "rotate") {
        const k = cles.get(nom);
        if (!k) return rep({}, 404);
        k.version += 1;
      } else if (!m[2]) cles.set(nom, { version: 1, secret: randomBytes(32) });
      return rep({ data: {} });
    }
    if ((m = /^transit\/(datakey\/plaintext|decrypt|rewrap|hmac)\/([a-z0-9-]+)$/.exec(chemin))) {
      const nom = m[2] as string;
      const cle = cles.get(nom);
      if (!cle) return rep({ errors: ["introuvable"] }, 404);
      if (m[1] === "datakey/plaintext") {
        const clair = randomBytes(32);
        etat.clairs.push(clair);
        return rep({ data: { plaintext: clair.toString("base64"), ciphertext: chiffreDe(nom, clair) } });
      }
      if (m[1] === "hmac") return rep({ data: { hmac: `vault:v1:${createHmac("sha256", cle.secret).update(Buffer.from(corps.input ?? "", "base64")).digest("base64")}` } });
      const connu = donnees.get(corps.ciphertext ?? "");
      if (!connu || connu.nom !== nom) return rep({ errors: ["refusé"] }, 400);
      return m[1] === "decrypt" ? rep({ data: { plaintext: connu.clair.toString("base64") } }) : rep({ data: { ciphertext: chiffreDe(nom, connu.clair) } });
    }
    return rep({}, 404);
  };
  return {
    etat,
    fetch: fetchFaux,
    async creerClient(tenantId: string) {
      cles.set(`cli-${tenantId}`, { version: 1, secret: randomBytes(32) });
      cles.set(`cli-${tenantId}-recherche`, { version: 1, secret: randomBytes(32) });
    },
  };
}

const A = randomUUID();
const B = randomUUID();
const MARQUEUR = `marqueur.${randomBytes(6).toString("hex")}@exemple.fr`;

function monter() {
  const bao = creerFauxTransit();
  const observees: Buffer[] = [];
  const base: OptionsBao & { observerCle: (b: Buffer) => void } = { url: "http://bao.test", jeton: `jeton-${randomBytes(6).toString("hex")}`, fetch: bao.fetch, observerCle: (b) => observees.push(b) };
  return { bao, observees, enveloppe: creerEnveloppe(base), colonnes: creerColonnesChiffrees(base) };
}
const refus = async (p: Promise<unknown>, code?: string) => {
  const e = await p.then(() => undefined, (x: unknown) => x);
  expect(e).toBeInstanceOf(ErreurCoffre);
  if (code) expect((e as ErreurCoffre).code).toBe(code);
  expect((e as Error).message).toBe((e as ErreurCoffre).code);
};

describe("colonnes chiffrées par la clé du client", () => {
  it("[A-243] un e-mail rangé dans commun.personnes est chiffré ; la base ne contient pas la valeur en clair (marqueur cherché)", async () => {
    const { bao, colonnes } = monter();
    await bao.creerClient(A);
    const octets = await colonnes.chiffrerChamp(A, MARQUEUR);
    expect(Buffer.isBuffer(octets)).toBe(true);
    for (const forme of [octets.toString("utf8"), octets.toString("hex"), octets.toString("base64"), octets.toString("latin1")]) {
      expect(forme).not.toContain(MARQUEUR);
      expect(forme).not.toContain(Buffer.from(MARQUEUR).toString("hex"));
    }
    expect(await colonnes.dechiffrerChamp(A, octets)).toBe(MARQUEUR);
  });

  it("[A-243] deux chiffrements de la même valeur diffèrent (nonce jamais réutilisé, une clé de données par champ)", async () => {
    const { bao, colonnes } = monter();
    await bao.creerClient(A);
    const un = await colonnes.chiffrerChamp(A, MARQUEUR);
    const deux = await colonnes.chiffrerChamp(A, MARQUEUR);
    expect(un.equals(deux)).toBe(false);
    const [e1, e2] = [lireEnveloppeChamp(un), lireEnveloppeChamp(deux)];
    expect(e1.chiffre.subarray(0, 12).equals(e2.chiffre.subarray(0, 12))).toBe(false);
    expect(e1.cleChiffree).not.toBe(e2.cleChiffree);
  });

  it("[A-243] @isolation un champ de A ne se déchiffre pas avec la clé de B", async () => {
    const { bao, colonnes } = monter();
    await bao.creerClient(A);
    await bao.creerClient(B);
    const deA = await colonnes.chiffrerChamp(A, MARQUEUR);
    await refus(colonnes.dechiffrerChamp(B, deA));
    expect(await colonnes.dechiffrerChamp(A, deA)).toBe(MARQUEUR);
  });

  it("[A-243] @isolation même si le coffre acceptait la clé de données d'un autre client, le lien au client (AAD) refuse", async () => {
    const { bao, colonnes, enveloppe } = monter();
    await bao.creerClient(A);
    await bao.creerClient(B);
    const e = lireEnveloppeChamp(await colonnes.chiffrerChamp(A, MARQUEUR));
    // La clé de données de A, rendue en clair par un coffre trop permissif, ne déchiffre pas le chiffré présenté comme celui de B.
    const clairDeA = bao.etat.clairs[0] as Buffer;
    const permissif = creerEnveloppe({ url: "http://bao.test", jeton: "j", fetch: async () => new Response(JSON.stringify({ data: { plaintext: clairDeA.toString("base64") } })) });
    await refus(permissif.dechiffrer(B, e), "dechiffrement_impossible");
    expect((await enveloppe.dechiffrer(A, e)).toString()).toBe(MARQUEUR);
  });

  it("[A-243] la recherche par empreinte retrouve la personne sans déchiffrer ; les empreintes de deux clients diffèrent", async () => {
    const { bao, colonnes } = monter();
    await bao.creerClient(A);
    await bao.creerClient(B);
    const deA = await colonnes.empreinteRecherche(A, MARQUEUR);
    expect(deA).toMatch(/^[0-9a-f]{64}$/);
    expect(await colonnes.empreinteRecherche(A, `  ${MARQUEUR.toUpperCase()} `)).toBe(deA);
    expect(await colonnes.empreinteRecherche(B, MARQUEUR)).not.toBe(deA);
    // Pas un SHA-256 nu : un dictionnaire sans la clé du client ne retrouve rien.
    expect(deA).not.toBe(createHash("sha256").update(MARQUEUR).digest("hex"));
    expect(bao.etat.appels.some((a) => a.includes("/decrypt/"))).toBe(false);
    expect(bao.etat.appels.filter((a) => a.includes("/hmac/")).every((a) => /hmac\/cli-[0-9a-f-]{36}-recherche$/.test(a))).toBe(true);
  });

  it("[A-243] normalisation : e-mail en minuscules sans espace, téléphone en E.164", () => {
    expect(normaliserEmail("  Marc.Essai@Exemple.FR \n")).toBe("marc.essai@exemple.fr");
    expect(normaliserTelephone("06 39 98 00 12")).toBe("+33639980012");
    expect(normaliserTelephone("+33 6 39 98 00 12")).toBe("+33639980012");
    expect(normaliserTelephone("0033.6.39.98.00.12")).toBe("+33639980012");
    expect(normaliserTelephone("(+33) 639-980-012")).toBe("+33639980012");
    for (const mauvais of ["", "abc", "12", "+0123456789", "+33 6 39 98 00 12 34 56 78 90"]) expect(() => normaliserTelephone(mauvais)).toThrow();
    for (const mauvais of ["", "sans-arobase", "a@@b.fr"]) expect(() => normaliserEmail(mauvais)).toThrow();
  });

  it("[A-243] après rotation, les anciens chiffrés se lisent et les nouveaux prennent la nouvelle version", async () => {
    const { bao, colonnes } = monter();
    await bao.creerClient(A);
    const ancien = await colonnes.chiffrerChamp(A, MARQUEUR);
    expect(lireEnveloppeChamp(ancien).version).toBe(1);
    await colonnes.pivoterCle(A);
    expect(bao.etat.appels).toContain(`POST transit/keys/cli-${A}/rotate`);
    const nouveau = await colonnes.chiffrerChamp(A, MARQUEUR);
    expect(lireEnveloppeChamp(nouveau).version).toBe(2);
    expect(await colonnes.dechiffrerChamp(A, ancien)).toBe(MARQUEUR);
    // Réenveloppement : seule la clé de données change de version, les données restent identiques.
    const refait = await colonnes.reenvelopper(A, ancien);
    expect(lireEnveloppeChamp(refait).version).toBe(2);
    expect(lireEnveloppeChamp(refait).chiffre.equals(lireEnveloppeChamp(ancien).chiffre)).toBe(true);
    expect(await colonnes.dechiffrerChamp(A, refait)).toBe(MARQUEUR);
    await refus(colonnes.pivoterCle(B));
  });

  it("[A-243] clé de données remise à zéro après usage, absente du chiffré et des erreurs", async () => {
    const { bao, colonnes, observees } = monter();
    await bao.creerClient(A);
    const octets = await colonnes.chiffrerChamp(A, MARQUEUR);
    await colonnes.dechiffrerChamp(A, octets);
    expect(observees.length).toBe(2);
    for (const b of observees) expect(b.every((x) => x === 0)).toBe(true);
    for (const clair of bao.etat.clairs) {
      // Le coffre de test garde sa propre copie ; le chiffré ne contient aucune forme de la clé de données.
      expect(octets.includes(clair)).toBe(false);
      expect(octets.toString("hex")).not.toContain(clair.toString("hex"));
    }
  });

  it("[A-243] clé du client absente ou identité invalide : refus, jamais de repli sur une autre clé", async () => {
    const { bao, colonnes } = monter();
    await bao.creerClient(A);
    await refus(colonnes.chiffrerChamp(B, MARQUEUR));
    await refus(colonnes.chiffrerChamp("systeme", MARQUEUR), "tenant_invalide");
    await refus(colonnes.empreinteRecherche("systeme", MARQUEUR), "tenant_invalide");
    await refus(colonnes.dechiffrerChamp(B, await colonnes.chiffrerChamp(A, MARQUEUR)));
    await refus(colonnes.empreinteRecherche(B, MARQUEUR));
    // Les demandes pour B visent la clé de B (absente) ; aucune n'a été redirigée vers la clé de A ou une clé commune.
    const sensibles = bao.etat.appels.filter((x) => /datakey|hmac|decrypt/.test(x));
    expect(sensibles.filter((x) => x.includes(`cli-${B}`))).toHaveLength(3);
    expect(sensibles.filter((x) => !x.includes(`cli-${B}`) && !x.includes(`cli-${A}`))).toEqual([]);
  });

  it("[A-243] un chiffré mal formé ou tronqué est refusé", async () => {
    const { bao, colonnes } = monter();
    await bao.creerClient(A);
    const octets = await colonnes.chiffrerChamp(A, MARQUEUR);
    for (const mauvais of [Buffer.alloc(0), octets.subarray(0, 5), octets.subarray(0, octets.length - 1), Buffer.concat([Buffer.from([9]), octets.subarray(1)])]) {
      await refus(colonnes.dechiffrerChamp(A, mauvais), "dechiffrement_impossible");
    }
  });

  it("[A-245] après destruction de la clé, champs illisibles, même après lecture à chaud (imitation)", async () => {
    const { bao, colonnes, enveloppe } = monter();
    await bao.creerClient(A);
    const octets = await colonnes.chiffrerChamp(A, MARQUEUR);
    expect(await colonnes.dechiffrerChamp(A, octets)).toBe(MARQUEUR);
    await enveloppe.detruireCleClient(A, `detruire-${A}`);
    await refus(colonnes.dechiffrerChamp(A, octets));
    await refus(colonnes.chiffrerChamp(A, MARQUEUR));
  });

  it("[C-011] coffre scellé : erreur coffre_scelle, jamais de clair", async () => {
    const { bao, colonnes } = monter();
    await bao.creerClient(A);
    const octets = await colonnes.chiffrerChamp(A, MARQUEUR);
    bao.etat.scelle = true;
    await refus(colonnes.chiffrerChamp(A, MARQUEUR), "coffre_scelle");
    await refus(colonnes.dechiffrerChamp(A, octets), "coffre_scelle");
    await refus(colonnes.empreinteRecherche(A, MARQUEUR), "coffre_scelle");
    await refus(colonnes.pivoterCle(A), "coffre_scelle");
  });
});
