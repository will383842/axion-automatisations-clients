import { describe, expect, it } from "vitest";
import { agregerVeille, enfilerAgregation, type Agregat, type DepotAgregats, type LigneExecution } from "./agreger.js";

// Exécutions fictives : clients et instances inventés (identifiants tirés pour l'essai).
const CLIENT_A = "11111111-1111-4111-8111-111111111111";
const CLIENT_B = "22222222-2222-4222-8222-222222222222";
const INST_1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const INST_2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const NUIT = new Date("2026-11-02T02:00:00.000Z");

function depotEnMemoire(lignes: LigneExecution[]): DepotAgregats & { terminer(l: LigneExecution, statut: LigneExecution["statut"], dureeMs: number): Promise<void>; agregats: Map<string, Agregat>; lignes: LigneExecution[]; horloge: { t: number } } {
  const agregats = new Map<string, Agregat>();
  // Horloge logique : `modifieA` d'une exécution et `ecritA` d'un agrégat, pour savoir qui est le plus récent.
  const horloge = { t: 0 };
  const modifieA = new WeakMap<LigneExecution, number>();
  const ecritA = new Map<string, number>();
  for (const l of lignes) modifieA.set(l, 0);
  return {
    agregats,
    lignes,
    horloge,
    async executionsDuJour(jour) {
      return lignes.filter((l) => l.jour === jour);
    },
    // Jours terminés (avant `avant`, exclu) avec des exécutions et : pas d'agrégat, ou exécution en cours, ou exécution modifiée après l'agrégat.
    async joursAAgreger(avant) {
      const cle = (l: LigneExecution) => `${l.tenantId}/${l.instanceId}/${l.jour}`;
      const jours = new Set(
        lignes.filter((l) => l.jour < avant && (!agregats.has(cle(l)) || l.statut === "en_cours" || (modifieA.get(l) ?? 0) > (ecritA.get(cle(l)) ?? 0))).map((l) => l.jour),
      );
      return [...jours].sort();
    },
    // Écriture « remplace » : la clé porte le client, l'instance et le jour.
    async enregistrer(a) {
      agregats.set(`${a.tenantId}/${a.instanceId}/${a.jour}`, a);
      ecritA.set(`${a.tenantId}/${a.instanceId}/${a.jour}`, ++horloge.t);
    },
    async terminer(l: LigneExecution, statut: LigneExecution["statut"], dureeMs: number) {
      Object.assign(l, { statut, dureeMs });
      modifieA.set(l, ++horloge.t);
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
    expect(r).toEqual({ jours: ["2026-11-01"], agregats: 2 });
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

  it("[A-181] une nuit manquée est rattrapée : tous les jours terminés sans agrégat sont traités, pas seulement la veille", async () => {
    const depot = depotEnMemoire([
      { ...ex(CLIENT_A, INST_1, "reussie", 10, 1), jour: "2026-10-24" },
      { ...ex(CLIENT_A, INST_1, "reussie", 20, 2), jour: "2026-10-25" },
      ex(CLIENT_A, INST_1, "reussie", 30, 3),
      { ...ex(CLIENT_A, INST_1, "reussie", 99, 9), jour: "2026-11-02" },
    ]);
    const r = await agregerVeille(depot, NUIT);
    expect(r.jours).toEqual(["2026-10-24", "2026-10-25", "2026-11-01"]);
    expect([...depot.agregats.keys()].sort()).toEqual([`${CLIENT_A}/${INST_1}/2026-10-24`, `${CLIENT_A}/${INST_1}/2026-10-25`, `${CLIENT_A}/${INST_1}/2026-11-01`]);
  });

  it("[A-181] heure d'hiver : une exécution du 25 octobre à 01:30 Paris (23:30Z le 24) compte pour le 24 octobre en UTC", async () => {
    const depot = depotEnMemoire([{ ...ex(CLIENT_A, INST_1, "reussie", 10, 1), jour: "2026-10-24" }]);
    await agregerVeille(depot, new Date("2026-10-25T02:00:00.000Z"));
    expect(depot.agregats.get(`${CLIENT_A}/${INST_1}/2026-10-24`)).toMatchObject({ nombre: 1 });
  });

  it("[A-181] une exécution en cours au calcul puis terminée : l'agrégat est corrigé la nuit suivante, sans doublon", async () => {
    const enCours = ex(CLIENT_A, INST_1, "en_cours", null, 0);
    const depot = depotEnMemoire([ex(CLIENT_A, INST_1, "reussie", 1000, 5), enCours]);
    // Nuit du 2 novembre 02:00Z : la veille est agrégée, l'exécution tourne encore (durée 0).
    await agregerVeille(depot, NUIT);
    expect(depot.agregats.get(`${CLIENT_A}/${INST_1}/2026-11-01`)).toMatchObject({ nombre: 2, dureeTotaleMs: 1000, coutMicroCentimes: 5 });
    // Elle se termine après l'écriture de l'agrégat.
    await depot.terminer(enCours, "reussie", 600);
    enCours.coutMicroCentimes = 4;
    // Nuit suivante (3 novembre) : le jour 1er est revu et la ligne REMPLACÉE.
    const r = await agregerVeille(depot, new Date("2026-11-03T02:00:00.000Z"));
    expect(r.jours).toEqual(["2026-11-01"]);
    expect(depot.agregats.size).toBe(1);
    expect(depot.agregats.get(`${CLIENT_A}/${INST_1}/2026-11-01`)).toMatchObject({ nombre: 2, dureeTotaleMs: 1600, coutMicroCentimes: 9 });
    // Une troisième nuit sans changement ne refait rien.
    expect((await agregerVeille(depot, new Date("2026-11-04T02:00:00.000Z"))).jours).toEqual([]);
  });
});
