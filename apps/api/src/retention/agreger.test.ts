import { describe, expect, it } from "vitest";
import { agregerVeille, enfilerAgregation, type Agregat, type DepotAgregats, type LigneExecution } from "./agreger.js";

// Exécutions fictives : clients et instances inventés (identifiants tirés pour l'essai).
const CLIENT_A = "11111111-1111-4111-8111-111111111111";
const CLIENT_B = "22222222-2222-4222-8222-222222222222";
const INST_1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const INST_2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const NUIT = new Date("2026-11-02T02:00:00.000Z");

function depotEnMemoire(lignes: LigneExecution[]): DepotAgregats & { agregats: Map<string, Agregat> } {
  const agregats = new Map<string, Agregat>();
  return {
    agregats,
    async executionsDuJour(jour) {
      return lignes.filter((l) => l.jour === jour);
    },
    // Écriture « remplace » : la clé porte le client, l'instance et le jour.
    async enregistrer(a) {
      agregats.set(`${a.tenantId}/${a.instanceId}/${a.jour}`, a);
    },
  };
}
const ex = (tenantId: string, instanceId: string, statut: LigneExecution["statut"], dureeMs: number | null, coutMicroCentimes: number): LigneExecution => ({ jour: "2026-11-01", tenantId, instanceId, statut, dureeMs, coutMicroCentimes });

describe("agrégat quotidien", () => {
  it("[A-181] l'agrégat de la veille compte exécutions, échecs, durée et coût par instance", async () => {
    const depot = depotEnMemoire([
      ex(CLIENT_A, INST_1, "reussie", 1000, 5),
      ex(CLIENT_A, INST_1, "echec", 400, 2),
      ex(CLIENT_A, INST_1, "en_cours", null, 0),
      ex(CLIENT_B, INST_2, "reussie", 250, 7),
    ]);
    const r = await agregerVeille(depot, NUIT);
    expect(r).toEqual({ jour: "2026-11-01", agregats: 2 });
    expect(depot.agregats.get(`${CLIENT_A}/${INST_1}/2026-11-01`)).toMatchObject({ nombre: 3, echecs: 1, dureeTotaleMs: 1400, coutMicroCentimes: 7 });
    expect(depot.agregats.get(`${CLIENT_B}/${INST_2}/2026-11-01`)).toMatchObject({ nombre: 1, echecs: 0, dureeTotaleMs: 250, coutMicroCentimes: 7 });
  });

  it("[A-181] @anti-doublon relancer l'agrégation de la même nuit ne double rien", async () => {
    const depot = depotEnMemoire([ex(CLIENT_A, INST_1, "reussie", 1000, 5), ex(CLIENT_A, INST_1, "echec", 400, 2)]);
    await agregerVeille(depot, NUIT);
    const avant = structuredClone([...depot.agregats.values()]);
    await agregerVeille(depot, NUIT);
    expect([...depot.agregats.values()]).toEqual(avant);
    expect(depot.agregats.size).toBe(1);
  });

  it("[A-181] la même instance dans deux clients différents donne deux agrégats (la clé porte le client)", async () => {
    const depot = depotEnMemoire([ex(CLIENT_A, INST_1, "reussie", 10, 1), ex(CLIENT_B, INST_1, "reussie", 20, 2)]);
    await agregerVeille(depot, NUIT);
    expect(depot.agregats.size).toBe(2);
  });

  it("[A-181] une somme au-delà de 2^53-1 est refusée, rien n'est écrit", async () => {
    const depot = depotEnMemoire([ex(CLIENT_A, INST_1, "reussie", Number.MAX_SAFE_INTEGER, 1), ex(CLIENT_A, INST_1, "reussie", 1, 1)]);
    await expect(agregerVeille(depot, NUIT)).rejects.toThrow(/borne/);
    expect(depot.agregats.size).toBe(0);
  });

  it("[A-181] la tâche de nuit porte un jobId égal au jour de la veille", async () => {
    const ajouts: { nom: string; options: unknown }[] = [];
    await enfilerAgregation({ add: async (nom: string, _d: unknown, options: unknown) => void ajouts.push({ nom, options }) } as never, NUIT);
    expect(ajouts).toEqual([{ nom: "agregat-quotidien", options: { jobId: "agregat-quotidien-2026-11-01" } }]);
  });
});
