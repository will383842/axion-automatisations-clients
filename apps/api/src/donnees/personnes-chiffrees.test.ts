import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ErreurCoffre } from "../coffre/coffre.js";
import { normaliserEmail, normaliserTelephone, type ContexteChamp } from "./colonnes-chiffrees.js";
import { creerPersonnesChiffrees, type ClientSql } from "./personnes-chiffrees.js";

// T2-54 : rangement de commun.personnes par les fonctions de T2-33. Ici, sans base ni coffre : un faux coffre qui lie le contexte au chiffré
// et une fausse base qui garde les lignes telles que la vraie les recevrait (paramètres seulement). La preuve sur une vraie base est dans le fichier .int.test.ts.
const A = randomUUID();
const ETAB = randomUUID();
const COURRIEL = "lucien.pellegrand@exemple.fr";
const TELEPHONE = "+33 6 39 98 01 23";

function fauxCoffre() {
  const appels: { fn: string; tenant: string; valeur?: string; contexte?: ContexteChamp }[] = [];
  return {
    appels,
    async chiffrerChamp(tenant: string, valeur: string, contexte: ContexteChamp): Promise<Buffer> {
      appels.push({ fn: "chiffrer", tenant, valeur, contexte });
      return Buffer.from(JSON.stringify({ t: tenant, c: contexte, v: Buffer.from(valeur).reverse().toString("base64") }));
    },
    async dechiffrerChamp(tenant: string, octets: Uint8Array, contexte: ContexteChamp): Promise<string> {
      appels.push({ fn: "dechiffrer", tenant, contexte });
      const x = JSON.parse(Buffer.from(octets).toString()) as { t: string; c: ContexteChamp; v: string };
      if (x.t !== tenant || x.c.colonne !== contexte.colonne || x.c.idLigne !== contexte.idLigne) throw new ErreurCoffre("dechiffrement_impossible");
      return Buffer.from(x.v, "base64").reverse().toString();
    },
    async empreinteRecherche(tenant: string, valeur: string): Promise<Buffer> {
      appels.push({ fn: "empreinte", tenant, valeur });
      const normalisee = valeur.includes("@") ? normaliserEmail(valeur) : normaliserTelephone(valeur);
      return createHash("sha256").update(`${tenant}/${normalisee}`).digest();
    },
  };
}

type Ligne = Record<string, unknown>;
function fausseBase() {
  const lignes: Ligne[] = [];
  const requetes: { texte: string; valeurs: unknown[] }[] = [];
  const sql: ClientSql = {
    async query(texte, valeurs = []) {
      requetes.push({ texte, valeurs });
      if (/^\s*INSERT/i.test(texte)) {
        const [id, etablissement_id, entreprise_id, nom, prenom, courriel_chiffre, courriel_empreinte, telephone_chiffre, telephone_empreinte] = valeurs;
        lignes.push({ id, etablissement_id, entreprise_id, nom, prenom, courriel_chiffre, courriel_empreinte, telephone_chiffre, telephone_empreinte });
        return { rows: [] };
      }
      if (/courriel_empreinte\s*=/i.test(texte)) return { rows: lignes.filter((l) => l["etablissement_id"] === valeurs[0] && Buffer.compare(l["courriel_empreinte"] as Buffer, valeurs[1] as Buffer) === 0).map((l) => ({ id: l["id"] })) };
      return { rows: lignes.filter((l) => l["id"] === valeurs[0]) };
    },
  };
  return { sql, lignes, requetes };
}

describe("personnes chiffrées (sans base)", () => {
  it("[A-243] ranger chiffre l'e-mail avec le contexte de la colonne et de la ligne, et n'envoie à la base que des paramètres sans le clair", async () => {
    const coffre = fauxCoffre();
    const base = fausseBase();
    const p = creerPersonnesChiffrees({ colonnes: coffre, sql: base.sql });
    const id = await p.ranger(A, { etablissementId: ETAB, nom: "Pellegrand", prenom: "Lucien", courriel: COURRIEL, telephone: TELEPHONE });
    const ch = coffre.appels.find((a) => a.fn === "chiffrer" && a.contexte?.colonne === "personnes.courriel_chiffre");
    expect(ch).toMatchObject({ tenant: A, valeur: COURRIEL, contexte: { colonne: "personnes.courriel_chiffre", idLigne: id } });
    const ligne = base.lignes[0] as Ligne;
    expect(ligne["id"]).toBe(id);
    expect(Buffer.isBuffer(ligne["courriel_chiffre"])).toBe(true);
    for (const r of base.requetes) {
      expect(r.texte).not.toContain("exemple.fr");
      expect(r.texte).toMatch(/\$1/); // paramétré
      for (const v of r.valeurs) if (typeof v === "string") expect(v).not.toContain("@");
    }
  });

  it("[A-201] le téléphone est chiffré avec son propre contexte et son empreinte fait 32 octets", async () => {
    const coffre = fauxCoffre();
    const base = fausseBase();
    const p = creerPersonnesChiffrees({ colonnes: coffre, sql: base.sql });
    const id = await p.ranger(A, { etablissementId: ETAB, nom: "Dufresnoy", telephone: TELEPHONE });
    expect(coffre.appels.find((a) => a.fn === "chiffrer")).toMatchObject({ valeur: TELEPHONE, contexte: { colonne: "personnes.telephone_chiffre", idLigne: id } });
    const ligne = base.lignes[0] as Ligne;
    expect((ligne["telephone_empreinte"] as Buffer).length).toBe(32);
    expect(ligne["courriel_chiffre"]).toBeNull();
    expect(ligne["courriel_empreinte"]).toBeNull();
  });

  it("[A-243] lire déchiffre avec le même contexte et rend la personne", async () => {
    const base = fausseBase();
    const p = creerPersonnesChiffrees({ colonnes: fauxCoffre(), sql: base.sql });
    const id = await p.ranger(A, { etablissementId: ETAB, nom: "Chaumeil", prenom: "Inès", courriel: COURRIEL, telephone: TELEPHONE });
    expect(await p.lire(A, id)).toMatchObject({ id, nom: "Chaumeil", prenom: "Inès", courriel: COURRIEL, telephone: TELEPHONE });
    expect(await p.lire(A, randomUUID())).toBeUndefined();
  });

  it("[A-243] @isolation le courriel d'une personne copié sur une autre ligne ne se lit pas", async () => {
    const base = fausseBase();
    const p = creerPersonnesChiffrees({ colonnes: fauxCoffre(), sql: base.sql });
    const un = await p.ranger(A, { etablissementId: ETAB, nom: "Montaigret", courriel: COURRIEL });
    const deux = await p.ranger(A, { etablissementId: ETAB, nom: "Escorbiac", courriel: "gaelle.escorbiac@personnes.test" });
    (base.lignes[1] as Ligne)["courriel_chiffre"] = (base.lignes[0] as Ligne)["courriel_chiffre"];
    await expect(p.lire(A, deux)).rejects.toBeInstanceOf(ErreurCoffre);
    expect((await p.lire(A, un))?.courriel).toBe(COURRIEL);
  });

  it("[A-243] trouverParCourriel cherche par empreinte, sans déchiffrer, et seulement dans l'établissement demandé", async () => {
    const coffre = fauxCoffre();
    const base = fausseBase();
    const p = creerPersonnesChiffrees({ colonnes: coffre, sql: base.sql });
    const id = await p.ranger(A, { etablissementId: ETAB, nom: "Thibarel", courriel: COURRIEL });
    const avant = coffre.appels.length;
    expect(await p.trouverParCourriel(A, ETAB, "  LUCIEN.Pellegrand@exemple.fr ")).toEqual([id]);
    expect(await p.trouverParCourriel(A, randomUUID(), COURRIEL)).toEqual([]);
    expect(coffre.appels.slice(avant).every((a) => a.fn === "empreinte")).toBe(true);
  });

  it("[A-243] deux graphies NFC et NFD de la même adresse donnent la même empreinte avant l'appel au coffre", async () => {
    const coffre = fauxCoffre();
    const base = fausseBase();
    const p = creerPersonnesChiffrees({ colonnes: coffre, sql: base.sql });
    const nfc = "élöise@exemple.fr".normalize("NFC");
    const nfd = nfc.normalize("NFD");
    expect(nfd).not.toBe(nfc);
    const id = await p.ranger(A, { etablissementId: ETAB, nom: "Vaudrelin", courriel: nfd });
    expect(await p.trouverParCourriel(A, ETAB, nfc)).toEqual([id]);
    expect(await p.trouverParCourriel(A, ETAB, nfd)).toEqual([id]);
    const envoyes = coffre.appels.filter((a) => a.fn === "empreinte").map((a) => a.valeur);
    expect(envoyes.every((v) => v === nfc)).toBe(true);
  });

  it("[A-243] ranger refuse un e-mail ou un téléphone invalide sans rien écrire", async () => {
    const base = fausseBase();
    const p = creerPersonnesChiffrees({ colonnes: fauxCoffre(), sql: base.sql });
    await expect(p.ranger(A, { etablissementId: ETAB, nom: "Roncevaux-Lamy", courriel: "pas-un-courriel" })).rejects.toThrow("email_invalide");
    await expect(p.ranger(A, { etablissementId: ETAB, nom: "Roncevaux-Lamy", telephone: "12" })).rejects.toThrow("telephone_invalide");
    expect(base.requetes).toEqual([]);
  });
});
