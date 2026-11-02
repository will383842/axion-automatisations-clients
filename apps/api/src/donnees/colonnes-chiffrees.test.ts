import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ErreurCoffre, type OptionsBao } from "../coffre/coffre.js";
import { creerEnveloppe } from "../coffre/enveloppe.js";
import { contexteChamp, creerColonnesChiffrees, delierContexte, lireEnveloppeChamp, normaliserEmail, normaliserTelephone } from "./colonnes-chiffrees.js";

// Faux OpenBao (moteur transit) : clés par client, versions, clés de données, HMAC. Tout est généré à l'exécution.
function creerFauxTransit() {
  const cles = new Map<string, { version: number; secrets: Buffer[] }>();
  const donnees = new Map<string, { nom: string; clair: Buffer }>();
  const etat = { scelle: false, appels: [] as string[], clairs: [] as Buffer[], corpsHmac: [] as Record<string, unknown>[], versionHmacForcee: undefined as number | undefined };
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
        k.secrets.push(randomBytes(32));
      } else if (!m[2]) cles.set(nom, { version: 1, secrets: [randomBytes(32)] });
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
      if (m[1] === "hmac") {
        etat.corpsHmac.push(corps);
        // Comme OpenBao : sans key_version, la dernière version ; avec, celle demandée. La version employée est rendue dans la réponse.
        const v = Number(corps.key_version ?? cle.version);
        const secret = cle.secrets[v - 1];
        if (!secret) return rep({ errors: ["version inconnue"] }, 400);
        return rep({ data: { hmac: `vault:v${etat.versionHmacForcee ?? v}:${createHmac("sha256", secret).update(Buffer.from(corps.input ?? "", "base64")).digest("base64")}` } });
      }
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
      cles.set(`cli-${tenantId}`, { version: 1, secrets: [randomBytes(32)] });
      cles.set(`cli-${tenantId}-recherche`, { version: 1, secrets: [randomBytes(32)] });
    },
    /** Rotation d'une clé du coffre par son nom (la clé de recherche n'a pas de méthode publique : la rotation vient du coffre). */
    pivoterNom(nom: string) {
      const k = cles.get(nom);
      if (!k) throw new Error("clé inconnue");
      k.version += 1;
      k.secrets.push(randomBytes(32));
    },
  };
}

const A = randomUUID();
const B = randomUUID();
const MARQUEUR = `marqueur.${randomBytes(6).toString("hex")}@exemple.fr`;
// Contexte lié au chiffré (point 3 de l'audit) : la colonne et la ligne. Un chiffré ne se lit qu'à sa place.
const LIGNE = randomUUID();
const CTX = { colonne: "personnes.courriel_chiffre", idLigne: LIGNE };

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
  it("[A-243] un champ chiffré par chiffrerChamp ne contient pas la valeur en clair (marqueur cherché dans les octets produits ; aucune base touchée, voir la dette de branchement de commun.personnes)", async () => {
    const { bao, colonnes } = monter();
    await bao.creerClient(A);
    const octets = await colonnes.chiffrerChamp(A, MARQUEUR, CTX);
    expect(Buffer.isBuffer(octets)).toBe(true);
    for (const forme of [octets.toString("utf8"), octets.toString("hex"), octets.toString("base64"), octets.toString("latin1")]) {
      expect(forme).not.toContain(MARQUEUR);
      expect(forme).not.toContain(Buffer.from(MARQUEUR).toString("hex"));
    }
    expect(await colonnes.dechiffrerChamp(A, octets, CTX)).toBe(MARQUEUR);
  });

  it("[A-243] deux chiffrements de la même valeur diffèrent (nonce jamais réutilisé, une clé de données par champ)", async () => {
    const { bao, colonnes } = monter();
    await bao.creerClient(A);
    const un = await colonnes.chiffrerChamp(A, MARQUEUR, CTX);
    const deux = await colonnes.chiffrerChamp(A, MARQUEUR, CTX);
    expect(un.equals(deux)).toBe(false);
    const [e1, e2] = [lireEnveloppeChamp(un), lireEnveloppeChamp(deux)];
    expect(e1.chiffre.subarray(0, 12).equals(e2.chiffre.subarray(0, 12))).toBe(false);
    expect(e1.cleChiffree).not.toBe(e2.cleChiffree);
  });

  it("[A-243] @isolation un champ de A ne se déchiffre pas avec la clé de B", async () => {
    const { bao, colonnes } = monter();
    await bao.creerClient(A);
    await bao.creerClient(B);
    const deA = await colonnes.chiffrerChamp(A, MARQUEUR, CTX);
    await refus(colonnes.dechiffrerChamp(B, deA, CTX));
    expect(await colonnes.dechiffrerChamp(A, deA, CTX)).toBe(MARQUEUR);
  });

  it("[A-243] @isolation même si le coffre acceptait la clé de données d'un autre client, le lien au client (AAD) refuse", async () => {
    const { bao, colonnes, enveloppe } = monter();
    await bao.creerClient(A);
    await bao.creerClient(B);
    const e = lireEnveloppeChamp(await colonnes.chiffrerChamp(A, MARQUEUR, CTX));
    // La clé de données de A, rendue en clair par un coffre trop permissif, ne déchiffre pas le chiffré présenté comme celui de B.
    const clairDeA = bao.etat.clairs[0] as Buffer;
    const permissif = creerEnveloppe({ url: "http://bao.test", jeton: "j", fetch: async () => new Response(JSON.stringify({ data: { plaintext: clairDeA.toString("base64") } })) });
    await refus(permissif.dechiffrer(B, e), "dechiffrement_impossible");
    expect(delierContexte(contexteChamp(CTX), await enveloppe.dechiffrer(A, e)).toString()).toBe(MARQUEUR);
  });

  it("[A-243] la recherche par empreinte retrouve la personne sans déchiffrer ; les empreintes de deux clients diffèrent", async () => {
    const { bao, colonnes } = monter();
    await bao.creerClient(A);
    await bao.creerClient(B);
    const deA = await colonnes.empreinteRecherche(A, MARQUEUR);
    // Colonne bytea contrainte à octet_length = 32 : l'empreinte est rendue en 32 octets, pas en texte hexadécimal.
    expect(Buffer.isBuffer(deA)).toBe(true);
    expect(deA.length).toBe(32);
    expect((await colonnes.empreinteRecherche(A, `  ${MARQUEUR.toUpperCase()} `)).equals(deA)).toBe(true);
    expect((await colonnes.empreinteRecherche(B, MARQUEUR)).equals(deA)).toBe(false);
    // Pas un SHA-256 nu : un dictionnaire sans la clé du client ne retrouve rien.
    expect(deA.equals(createHash("sha256").update(MARQUEUR).digest())).toBe(false);
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
    const ancien = await colonnes.chiffrerChamp(A, MARQUEUR, CTX);
    expect(lireEnveloppeChamp(ancien).version).toBe(1);
    await colonnes.pivoterCle(A);
    expect(bao.etat.appels).toContain(`POST transit/keys/cli-${A}/rotate`);
    const nouveau = await colonnes.chiffrerChamp(A, MARQUEUR, CTX);
    expect(lireEnveloppeChamp(nouveau).version).toBe(2);
    expect(await colonnes.dechiffrerChamp(A, ancien, CTX)).toBe(MARQUEUR);
    // Réenveloppement : seule la clé de données change de version, les données restent identiques.
    const refait = await colonnes.reenvelopper(A, ancien);
    expect(lireEnveloppeChamp(refait).version).toBe(2);
    expect(lireEnveloppeChamp(refait).chiffre.equals(lireEnveloppeChamp(ancien).chiffre)).toBe(true);
    expect(await colonnes.dechiffrerChamp(A, refait, CTX)).toBe(MARQUEUR);
    await refus(colonnes.pivoterCle(B));
  });

  it("[A-243] @isolation un courriel copié d'une personne sur une autre est refusé", async () => {
    const { bao, colonnes } = monter();
    await bao.creerClient(A);
    const autre = { colonne: CTX.colonne, idLigne: randomUUID() };
    const octets = await colonnes.chiffrerChamp(A, MARQUEUR, CTX);
    await refus(colonnes.dechiffrerChamp(A, octets, autre), "dechiffrement_impossible");
    expect(await colonnes.dechiffrerChamp(A, octets, CTX)).toBe(MARQUEUR);
  });

  it("[A-243] @isolation courriel et téléphone échangés sur la même ligne : refus dans les deux sens", async () => {
    const { bao, colonnes } = monter();
    await bao.creerClient(A);
    const courriel = { colonne: "personnes.courriel_chiffre", idLigne: LIGNE };
    const telephone = { colonne: "personnes.telephone_chiffre", idLigne: LIGNE };
    const ch = await colonnes.chiffrerChamp(A, MARQUEUR, courriel);
    const tel = await colonnes.chiffrerChamp(A, "+33639980012", telephone);
    await refus(colonnes.dechiffrerChamp(A, ch, telephone), "dechiffrement_impossible");
    await refus(colonnes.dechiffrerChamp(A, tel, courriel), "dechiffrement_impossible");
    expect(await colonnes.dechiffrerChamp(A, tel, telephone)).toBe("+33639980012");
  });

  it("[A-243] le contexte est exigé : colonne ou ligne vide ou mal formée refusée avant tout appel au coffre", async () => {
    const { bao, colonnes } = monter();
    await bao.creerClient(A);
    for (const mauvais of [{ colonne: "", idLigne: LIGNE }, { colonne: "personnes.courriel_chiffre", idLigne: "" }, { colonne: "fichier:x", idLigne: LIGNE }, { colonne: "personnes.courriel:chiffre", idLigne: LIGNE }]) {
      await expect(colonnes.chiffrerChamp(A, MARQUEUR, mauvais)).rejects.toBeInstanceOf(Error);
    }
    expect(bao.etat.appels.filter((x) => x.includes("datakey"))).toEqual([]);
  });

  it("[A-243] l'empreinte d'une même valeur reste identique après rotation de la clé de recherche (version épinglée)", async () => {
    const { bao, colonnes } = monter();
    await bao.creerClient(A);
    const avant = await colonnes.empreinteRecherche(A, MARQUEUR);
    bao.pivoterNom(`cli-${A}-recherche`);
    bao.pivoterNom(`cli-${A}-recherche`);
    const apres = await colonnes.empreinteRecherche(A, MARQUEUR);
    expect(apres.equals(avant)).toBe(true);
    // Chaque demande de HMAC épingle la version : jamais « la dernière ».
    expect(bao.etat.corpsHmac.length).toBe(2);
    for (const c of bao.etat.corpsHmac) expect(c.key_version).toBe(1);
  });

  it("[A-243] une réponse HMAC d'une autre version que celle épinglée est refusée (jamais d'index faussé en silence)", async () => {
    const { bao, colonnes } = monter();
    await bao.creerClient(A);
    bao.etat.versionHmacForcee = 2;
    await refus(colonnes.empreinteRecherche(A, MARQUEUR), "coffre_indisponible");
  });

  it("[A-243] clé de données remise à zéro après usage, absente du chiffré et des erreurs", async () => {
    const { bao, colonnes, observees } = monter();
    await bao.creerClient(A);
    const octets = await colonnes.chiffrerChamp(A, MARQUEUR, CTX);
    await colonnes.dechiffrerChamp(A, octets, CTX);
    // Ne prouve que le Buffer de la clé de données, remis à zéro par l'enveloppe (observerCle). La chaîne base64 rendue par le coffre
    // est une chaîne JavaScript immuable : elle n'est pas effaçable et reste en mémoire jusqu'au ramasse-miettes (limite connue).
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
    await refus(colonnes.chiffrerChamp(B, MARQUEUR, CTX));
    await refus(colonnes.chiffrerChamp("systeme", MARQUEUR, CTX), "tenant_invalide");
    await refus(colonnes.empreinteRecherche("systeme", MARQUEUR), "tenant_invalide");
    await refus(colonnes.dechiffrerChamp(B, await colonnes.chiffrerChamp(A, MARQUEUR, CTX), CTX));
    await refus(colonnes.empreinteRecherche(B, MARQUEUR));
    // Les demandes pour B visent la clé de B (absente) ; aucune n'a été redirigée vers la clé de A ou une clé commune.
    const sensibles = bao.etat.appels.filter((x) => /datakey|hmac|decrypt/.test(x));
    expect(sensibles.filter((x) => x.includes(`cli-${B}`))).toHaveLength(3);
    expect(sensibles.filter((x) => !x.includes(`cli-${B}`) && !x.includes(`cli-${A}`))).toEqual([]);
  });

  it("[A-243] un chiffré mal formé ou tronqué est refusé", async () => {
    const { bao, colonnes } = monter();
    await bao.creerClient(A);
    const octets = await colonnes.chiffrerChamp(A, MARQUEUR, CTX);
    for (const mauvais of [Buffer.alloc(0), octets.subarray(0, 5), octets.subarray(0, octets.length - 1), Buffer.concat([Buffer.from([9]), octets.subarray(1)])]) {
      await refus(colonnes.dechiffrerChamp(A, mauvais, CTX), "dechiffrement_impossible");
    }
  });

  it("[A-245] après destruction de la clé, champs illisibles, même après lecture à chaud (imitation)", async () => {
    const { bao, colonnes, enveloppe } = monter();
    await bao.creerClient(A);
    const octets = await colonnes.chiffrerChamp(A, MARQUEUR, CTX);
    expect(await colonnes.dechiffrerChamp(A, octets, CTX)).toBe(MARQUEUR);
    await enveloppe.detruireCleClient(A, `detruire-${A}`);
    await refus(colonnes.dechiffrerChamp(A, octets, CTX));
    await refus(colonnes.chiffrerChamp(A, MARQUEUR, CTX));
  });

  it("[C-011] coffre scellé : erreur coffre_scelle, jamais de clair", async () => {
    const { bao, colonnes } = monter();
    await bao.creerClient(A);
    const octets = await colonnes.chiffrerChamp(A, MARQUEUR, CTX);
    bao.etat.scelle = true;
    await refus(colonnes.chiffrerChamp(A, MARQUEUR, CTX), "coffre_scelle");
    await refus(colonnes.dechiffrerChamp(A, octets, CTX), "coffre_scelle");
    await refus(colonnes.empreinteRecherche(A, MARQUEUR), "coffre_scelle");
    await refus(colonnes.pivoterCle(A), "coffre_scelle");
  });
});
