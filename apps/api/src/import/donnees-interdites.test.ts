import { describe, expect, it } from "vitest";
import { detecter, verifierImport } from "./donnees-interdites.ts";

// T2-47 : détection des données interdites à l'import, sur les noms de colonnes seulement (jamais sur le contenu).
describe("détection des données interdites à l'import", () => {
  it("[C-060] une colonne nommée numero_securite_sociale, NIR ou IBAN est repérée et l'import refusé", async () => {
    expect(detecter(["nom", "numero_securite_sociale", "NIR", "IBAN"])).toEqual([
      { colonne: "numero_securite_sociale", categorie: "securite_sociale" },
      { colonne: "NIR", categorie: "securite_sociale" },
      { colonne: "IBAN", categorie: "bancaire" },
    ]);
    const requetes: unknown[][] = [];
    const client = { query: async (_t: string, v: unknown[] = []) => (requetes.push(v), { rows: [], rowCount: 1 }) };
    await expect(verifierImport(client, "equipe-lemoine", ["nom", "IBAN"])).rejects.toMatchObject({ code: "regle_metier", motif: "donnees_interdites", colonnes: [{ colonne: "IBAN", categorie: "bancaire" }] });
  });

  it("[C-060] les noms avec accents, majuscules et espaces sont normalisés avant la comparaison", () => {
    expect(detecter(["Numéro de Sécurité Sociale", "numeroSecuriteSociale", "Mot de passe", "SANTÉ", "Casier-Judiciaire", "Opinion politique"]).map((c) => c.categorie)).toEqual([
      "securite_sociale", "securite_sociale", "mot_de_passe", "sante", "infraction", "opinion",
    ]);
    // Un mot qui contient seulement les lettres d'un motif court n'est pas un motif (« senior » n'est pas « nir »).
    expect(detecter(["senior", "libanais", "nirvana_label"])).toEqual([]);
  });

  it("[C-060] un fichier sans colonne interdite passe", async () => {
    expect(detecter(["nom", "prenom", "courriel", "telephone", "entreprise"])).toEqual([]);
    const client = { query: async () => { throw new Error("aucune trace pour un import accepté"); } };
    await expect(verifierImport(client, "equipe-lemoine", ["nom", "prenom", "courriel"])).resolves.toBeUndefined();
  });

  it("[C-060] le refus est tracé sans contenu", async () => {
    const requetes: { texte: string; valeurs: unknown[] }[] = [];
    const client = { query: async (texte: string, valeurs: unknown[] = []) => (requetes.push({ texte, valeurs }), { rows: [], rowCount: 1 }) };
    await expect(verifierImport(client, "equipe-lemoine", ["groupe sanguin", "IBAN"])).rejects.toMatchObject({ motif: "donnees_interdites" });
    expect(requetes).toHaveLength(1);
    expect(requetes[0]?.texte).toMatch(/INSERT INTO trace\.evenements/);
    expect(requetes[0]?.valeurs).toEqual(["equipe-lemoine", "refus:donnees_interdites:sante,bancaire"]);
    // Ni nom de colonne ni valeur : seulement les catégories.
    expect(JSON.stringify(requetes)).not.toMatch(/IBAN|sanguin/);
    // Pas de repli sur un acteur par défaut : sans acteur, l'import est refusé avant toute trace.
    await expect(verifierImport(client, "", ["IBAN"])).rejects.toThrow(/acteur/);
  });
});

// Tests ordinaires (sans grappe) des garanties de minimisation côté import ; la preuve de bout en bout est dans tests/minimisation/*.int.test.ts.
describe("minimisation à l'import : un refus ne garde rien", () => {
  const enregistrer = () => {
    const textes: string[] = [];
    return { textes, client: { query: async (t: string) => (textes.push(t), { rows: [], rowCount: 1 }) } };
  };
  it("[A-033] un refus d'import ne laisse aucun contenu : une seule écriture, la trace sans contenu", async () => {
    const { textes, client } = enregistrer();
    await expect(verifierImport(client, "equipe-bertin", ["IBAN", "nom"])).rejects.toMatchObject({ motif: "donnees_interdites" });
    expect(textes).toHaveLength(1);
    expect(textes[0]).toMatch(/^INSERT INTO trace\.evenements/);
  });
  it("[A-198] la plateforme ne garde aucun contenu en transit : un import accepté n'écrit rien lors de la vérification", async () => {
    const { textes, client } = enregistrer();
    await verifierImport(client, "equipe-bertin", ["nom", "prenom"]);
    expect(textes).toEqual([]);
  });
  it("[C-027] le refus s'inscrit dans la base du client (schéma trace), pas dans la console", async () => {
    const { textes, client } = enregistrer();
    await expect(verifierImport(client, "equipe-bertin", ["mot de passe"])).rejects.toThrow();
    expect(textes.every((t) => /trace\.evenements/.test(t) && !/public\./.test(t))).toBe(true);
  });
  it("[C-043] la vérification ne supprime ni ne modifie jamais de données existantes", async () => {
    const { textes, client } = enregistrer();
    await expect(verifierImport(client, "equipe-bertin", ["iban"])).rejects.toThrow();
    expect(textes.join(" ")).not.toMatch(/\b(DELETE|UPDATE|TRUNCATE|DROP)\b/i);
  });
});

