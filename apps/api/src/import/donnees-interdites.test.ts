import { describe, expect, it } from "vitest";
import { detecter, ErreurDonneesInterdites, verifierImport } from "./donnees-interdites.ts";

// T2-47 : détection des données interdites à l'import, sur les noms de colonnes seulement (jamais sur le contenu).
describe("détection des données interdites à l'import", () => {
  it("[C-060] une colonne nommée numero_securite_sociale, NIR ou IBAN est repérée et l'import refusé", async () => {
    expect(detecter(["nom", "numero_securite_sociale", "NIR", "IBAN"])).toEqual([
      { colonne: "numero_securite_sociale", categorie: "securite_sociale" },
      { colonne: "NIR", categorie: "securite_sociale" },
      { colonne: "IBAN", categorie: "bancaire" },
    ]);
    const client = { query: async () => ({ rows: [], rowCount: 1 }) };
    const verdict = await verifierImport(client, "equipe-lemoine", ["nom", "IBAN"]);
    expect(verdict.accepte).toBe(false);
    if (verdict.accepte) throw new Error("refus attendu");
    expect(verdict.erreur).toBeInstanceOf(ErreurDonneesInterdites);
    expect(verdict.erreur).toMatchObject({ code: "regle_metier", motif: "donnees_interdites", colonnes: [{ colonne: "IBAN", categorie: "bancaire" }] });
  });

  it("[C-060] les noms avec accents, majuscules et espaces sont normalisés avant la comparaison", () => {
    expect(detecter(["Numéro de Sécurité Sociale", "numeroSecuriteSociale", "Mot de passe", "SANTÉ", "Casier-Judiciaire", "Opinion politique"]).map((c) => c.categorie)).toEqual([
      "securite_sociale", "securite_sociale", "mot_de_passe", "sante", "infraction", "opinion",
    ]);
    // Un mot qui contient seulement les lettres d'un motif court n'est pas un motif (« senior » n'est pas « nir »).
    expect(detecter(["senior", "libanais", "nirvana_label"])).toEqual([]);
  });

  it.each([
    ["Numéro de sécu", "securite_sociale"],
    ["N° sécu", "securite_sociale"],
    ["numSecu", "securite_sociale"],
    ["carte vitale", "securite_sociale"],
    ["Numéro INSEE", "securite_sociale"],
    ["opinions politiques", "opinion"],
    ["maladies", "sante"],
    ["allergies", "sante"],
    ["médecin traitant", "sante"],
    ["ordonnance", "sante"],
    ["syndicat", "opinion"],
    ["appartenance syndicale", "opinion"],
    ["confession", "opinion"],
    ["origine raciale", "opinion"],
    ["pwd", "mot_de_passe"],
    ["code PIN", "mot_de_passe"],
    ["ＩＢＡＮ", "bancaire"],
    ["Numéro de carte bancaire", "bancaire"],
    ["numero_carte_bancaire", "bancaire"],
    ["numéros de cartes bancaires", "bancaire"],
  ])("[C-060] la variante « %s » est repérée (%s)", (colonne, categorie) => {
    expect(detecter([colonne])).toEqual([{ colonne, categorie }]);
  });

  it.each(["numero_carte", "numero_de_carte_client", "etablissement_sante", "professionnel_sante", "secteur_sante", "diagnostic_energetique", "Diagnostic énergétique", "carte_grise", "carte_fidelite", "date_diagnostic", "code_insee"])(
    "[C-060] la colonne légitime « %s » passe",
    (colonne) => {
      expect(detecter([colonne])).toEqual([]);
    },
  );

  it("[C-060] une exception ne couvre que le nom exact : une colonne plus longue reste repérée", () => {
    expect(detecter(["etablissement_sante_numero_secu"]).map((c) => c.categorie)).toEqual(["sante"]);
  });

  it("[C-060] un fichier sans colonne interdite passe", async () => {
    expect(detecter(["nom", "prenom", "courriel", "telephone", "entreprise"])).toEqual([]);
    const client = { query: async () => { throw new Error("aucune trace pour un import accepté"); } };
    await expect(verifierImport(client, "equipe-lemoine", ["nom", "prenom", "courriel"])).resolves.toEqual({ accepte: true });
  });

  it("[C-060] le refus est tracé sans contenu", async () => {
    const requetes: { texte: string; valeurs: unknown[] }[] = [];
    const client = { query: async (texte: string, valeurs: unknown[] = []) => (requetes.push({ texte, valeurs }), { rows: [], rowCount: 1 }) };
    const verdict = await verifierImport(client, "equipe-lemoine", ["groupe sanguin", "IBAN"]);
    expect(verdict.accepte).toBe(false);
    expect(requetes).toHaveLength(1);
    expect(requetes[0]?.texte).toMatch(/INSERT INTO trace\.evenements/);
    expect(requetes[0]?.valeurs).toEqual(["equipe-lemoine", "refus:donnees_interdites:sante,bancaire"]);
    // Ni nom de colonne ni valeur : seulement les catégories.
    expect(JSON.stringify(requetes)).not.toMatch(/IBAN|sanguin/);
    // Pas de repli sur un acteur par défaut : sans acteur, l'import est refusé avant toute trace.
    await expect(verifierImport(client, "", ["IBAN"])).rejects.toThrow(/acteur/);
  });

  it("[C-060] le refus ne lève pas : l'appelant transactionnel valide la trace (COMMIT) avant de renvoyer l'erreur", async () => {
    const journal: string[] = [];
    const client = { query: async (t: string) => (journal.push(t), { rows: [], rowCount: 1 }) };
    // Si verifierImport levait dans la transaction, le ROLLBACK annulerait la trace du refus.
    const verdict = await verifierImport(client, "equipe-lemoine", ["IBAN"]);
    expect(verdict.accepte).toBe(false);
    journal.push("COMMIT");
    expect(journal.map((t) => t.split(" ")[0])).toEqual(["INSERT", "COMMIT"]);
  });

  it("[C-060] les noms recopiés dans le message sont bornés à 60 caractères", () => {
    const long = `${"a".repeat(150)}_iban`;
    const erreur = new ErreurDonneesInterdites(detecter([long]));
    expect(erreur.message).not.toContain("a".repeat(61));
    expect(erreur.message).toContain("a".repeat(59));
    expect(erreur.colonnes[0]?.colonne).toBe(long);
  });
});

// Tests ordinaires (sans grappe) du comportement de refus. Ils ne prouvent PAS la minimisation de bout en bout (dette LOT2-dette-T2-47-garde).
describe("refus d'import : ce que fait verifierImport", () => {
  const enregistrer = () => {
    const textes: string[] = [];
    return { textes, client: { query: async (t: string) => (textes.push(t), { rows: [], rowCount: 1 }) } };
  };
  it("[C-060] un refus d'import ne garde rien : une seule écriture, la trace sans contenu", async () => {
    const { textes, client } = enregistrer();
    expect((await verifierImport(client, "equipe-bertin", ["IBAN", "nom"])).accepte).toBe(false);
    expect(textes).toHaveLength(1);
    expect(textes[0]).toMatch(/^INSERT INTO trace\.evenements/);
  });
  it("[C-060] un import accepté n'écrit rien lors de la vérification", async () => {
    const { textes, client } = enregistrer();
    await verifierImport(client, "equipe-bertin", ["nom", "prenom"]);
    expect(textes).toEqual([]);
  });
  it("[C-060] le refus s'inscrit dans le schéma trace de la base appelée, jamais ailleurs", async () => {
    const { textes, client } = enregistrer();
    await verifierImport(client, "equipe-bertin", ["mot de passe"]);
    expect(textes.every((t) => /trace\.evenements/.test(t) && !/public\./.test(t))).toBe(true);
  });
  it("[C-060] la vérification ne supprime ni ne modifie jamais de données existantes", async () => {
    const { textes, client } = enregistrer();
    await verifierImport(client, "equipe-bertin", ["iban"]);
    expect(textes.join(" ")).not.toMatch(/\b(DELETE|UPDATE|TRUNCATE|DROP)\b/i);
  });
});
