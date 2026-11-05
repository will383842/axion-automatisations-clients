import { describe, expect, it } from "vitest";
import { importerPersonnes, type TransactionImport } from "./importer.ts";

// Base factice transactionnelle : les écritures non validées disparaissent à l'annulation, comme dans PostgreSQL.
function baseFactice() {
  const validees: string[] = [];
  const journal: string[] = [];
  const ouvrir = async (): Promise<TransactionImport> => {
    const enCours: string[] = [];
    return {
      client: { query: async (t: string) => (journal.push(t.split(" ").slice(0, 3).join(" ")), enCours.push(t), { rows: [], rowCount: 1 }) },
      valider: async () => { journal.push("COMMIT"); validees.push(...enCours); },
      annuler: async () => { journal.push("ROLLBACK"); },
    };
  };
  return { validees, journal, ports: { ouvrir } };
}
const session = { acteur: "equipe-lemoine", etablissementId: "11111111-1111-4111-8111-111111111111" };

describe("import de personnes : branchement de verifierImport", () => {
  it("[C-060] verifierImport est appelé : un fichier avec une colonne IBAN est refusé et rien n'est stocké", async () => {
    const { ports, validees } = baseFactice();
    await expect(importerPersonnes(ports, session, { colonnes: ["nom", "IBAN"], lignes: [{ nom: "Bertin", IBAN: "x" }] })).rejects.toMatchObject({ code: "regle_metier", motif: "donnees_interdites" });
    expect(validees.some((t) => /commun\.personnes/.test(t))).toBe(false);
  });

  it("[C-060] la trace d'un refus est validée (COMMIT) avant que l'erreur soit renvoyée, sans ROLLBACK", async () => {
    const { ports, journal, validees } = baseFactice();
    await expect(importerPersonnes(ports, session, { colonnes: ["nom", "mot de passe"], lignes: [] })).rejects.toThrow();
    expect(journal).toEqual(["INSERT INTO trace.evenements", "COMMIT"]);
    expect(validees).toHaveLength(1);
    expect(validees[0]).toMatch(/trace\.evenements/);
  });

  it("[A-033] la trace du refus ne contient aucune valeur du fichier ni nom de colonne", async () => {
    const textes: unknown[] = [];
    const ports = { ouvrir: async (): Promise<TransactionImport> => ({ client: { query: async (t: string, v?: unknown[]) => (textes.push(t, v), { rows: [], rowCount: 1 }) }, valider: async () => undefined, annuler: async () => undefined }) };
    await expect(importerPersonnes(ports, session, { colonnes: ["nom", "IBAN"], lignes: [{ nom: "MARQUEUR-ESSAI-abc", IBAN: "FR00" }] })).rejects.toThrow();
    expect(JSON.stringify(textes)).not.toMatch(/MARQUEUR-ESSAI|FR00|IBAN/);
  });

  it("[C-027] un import accepté écrit dans commun.personnes de la base appelée, puis valide", async () => {
    const { ports, journal } = baseFactice();
    await importerPersonnes(ports, session, { colonnes: ["nom", "prenom"], lignes: [{ nom: "Bertin", prenom: "Anne" }, { nom: "Rivoire" }] });
    expect(journal).toEqual(["INSERT INTO commun.personnes", "INSERT INTO commun.personnes", "COMMIT"]);
  });

  it("[C-043] chaque ligne est écrite seulement si elle n'existe pas déjà : un deuxième import ne double pas la ligne", async () => {
    const textes: string[] = [];
    const ports = { ouvrir: async (): Promise<TransactionImport> => ({ client: { query: async (t: string) => (textes.push(t), { rows: [], rowCount: 0 }) }, valider: async () => undefined, annuler: async () => undefined }) };
    await importerPersonnes(ports, session, { colonnes: ["nom"], lignes: [{ nom: "Bertin" }] });
    expect(textes[0]).toMatch(/WHERE NOT EXISTS/);
  });

  it("[C-060] une erreur imprévue pendant l'import annule la transaction (aucune trace ni ligne à moitié écrite)", async () => {
    const journal: string[] = [];
    const ports = { ouvrir: async (): Promise<TransactionImport> => ({ client: { query: async () => { throw new Error("panne"); } }, valider: async () => void journal.push("COMMIT"), annuler: async () => void journal.push("ROLLBACK") }) };
    await expect(importerPersonnes(ports, session, { colonnes: ["nom"], lignes: [{ nom: "Bertin" }] })).rejects.toThrow("panne");
    expect(journal).toEqual(["ROLLBACK"]);
  });
});
