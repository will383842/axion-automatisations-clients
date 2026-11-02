import { describe, expect, it } from "vitest";
import { purgerExecutions, type DepotPartitions, type EvenementRetention, type GelLitige, type Partition } from "./purger.js";

const CLIENT_A = "11111111-1111-4111-8111-111111111111";
const CLIENT_B = "22222222-2222-4222-8222-222222222222";
const AUJOURDHUI = new Date("2026-11-02T03:00:00.000Z");
const jourIl = (jours: number) => new Date(AUJOURDHUI.getTime() - jours * 86_400_000).toISOString().slice(0, 10);

// Partition mensuelle fictive qui finit (exclue) à `fin`.
type Fictive = Partition & { joursSansAgregat: string[]; enCours: number; lignes: number };
const partition = (nom: string, fin: string, tenants: string[], joursSansAgregat: string[] = [], enCours = 0, lignes = 1): Fictive => ({ nom, fin, tenants, joursSansAgregat, enCours, lignes });

function monde(partitions: Fictive[]) {
  const retirees: string[] = [];
  const recalculees: string[] = [];
  const journal: EvenementRetention[] = [];
  const ordre: string[] = [];
  const depot: DepotPartitions = {
    // Le dépôt renvoie TOUTES les partitions : le filtre sur la limite de 90 jours est celui du code, pas celui du dépôt simulé.
    async partitionsTerminees() {
      return partitions;
    },
    async joursSansAgregat(p) {
      return partitions.find((x) => x.nom === p.nom)?.joursSansAgregat ?? [];
    },
    async executionsEnCours(p) {
      return partitions.find((x) => x.nom === p.nom)?.enCours ?? 0;
    },
    async recalculerAgregats(p) {
      recalculees.push(p.nom);
      ordre.push(`recalcul:${p.nom}`);
    },
    async nombreExecutions(p) {
      return partitions.find((x) => x.nom === p.nom)?.lignes ?? 0;
    },
    async retirerPartition(nom) {
      retirees.push(nom);
      ordre.push(`retrait:${nom}`);
    },
  };
  const sansGel: GelLitige = { estReel: true, gelActif: async () => false };
  return { depot, retirees, recalculees, journal, ordre, ecrire: async (e: EvenementRetention) => void (journal.push(e), ordre.push(`journal:${e.type}`)), sansGel };
}

describe("purge du détail des exécutions", () => {
  it("[A-180] une partition de plus de 90 jours est retirée entière, interrupteur ouvert, et son agrégat reste", async () => {
    const m = monde([partition("executions_2026_07", jourIl(95), [CLIENT_A])]);
    const r = await purgerExecutions({ depot: m.depot, gel: m.sansGel, journal: m.ecrire, active: true, maintenant: AUJOURDHUI });
    expect(m.retirees).toEqual(["executions_2026_07"]);
    expect(r.retirees).toEqual(["executions_2026_07"]);
    // Le retrait ne touche que le détail : aucun appel qui supprimerait un agrégat n'existe dans le port.
    expect(Object.keys(m.depot)).not.toContain("supprimerAgregats");
  });

  it("[C-039] une partition qui finit à 89 jours reste, celle qui finit à 90 jours est retirée (le dépôt renvoie tout)", async () => {
    const m = monde([partition("executions_2026_08", jourIl(89), [CLIENT_A]), partition("executions_2026_07", jourIl(90), [CLIENT_A])]);
    await purgerExecutions({ depot: m.depot, gel: m.sansGel, journal: m.ecrire, active: true, maintenant: AUJOURDHUI });
    expect(m.retirees).toEqual(["executions_2026_07"]);
  });

  it.each([
    ["00:30Z", new Date("2026-11-02T00:30:00.000Z")],
    ["23:30Z", new Date("2026-11-02T23:30:00.000Z")],
  ])("[C-039] borne en heure à %s : fin au 5 août reste, fin au 4 août est retirée", async (_nom, maintenant) => {
    // Le 4 août 00:00Z est à plus de 90 jours de 2 novembre 00:30Z comme de 23:30Z ; le 5 août 00:00Z est à moins de 90 jours de 23:30Z.
    const m = monde([partition("executions_2026_05", "2026-08-05", [CLIENT_A]), partition("executions_2026_04", "2026-08-04", [CLIENT_A])]);
    await purgerExecutions({ depot: m.depot, gel: m.sansGel, journal: m.ecrire, active: true, maintenant });
    expect(m.retirees).toEqual(["executions_2026_04"]);
  });

  it("[A-180] une partition avec une exécution en cours n'est pas retirée", async () => {
    const m = monde([partition("executions_2026_07", jourIl(95), [CLIENT_A], [], 1)]);
    const r = await purgerExecutions({ depot: m.depot, gel: m.sansGel, journal: m.ecrire, active: true, maintenant: AUJOURDHUI });
    expect(m.retirees).toEqual([]);
    expect(r.refusees).toEqual([{ partition: "executions_2026_07", motif: "execution_en_cours" }]);
  });

  it("[A-180] les agrégats de toute la partition sont recalculés juste avant le retrait, après le gel relu", async () => {
    const m = monde([partition("executions_2026_07", jourIl(95), [CLIENT_A])]);
    await purgerExecutions({ depot: m.depot, gel: m.sansGel, journal: m.ecrire, active: true, maintenant: AUJOURDHUI });
    expect(m.recalculees).toEqual(["executions_2026_07"]);
    expect(m.ordre.indexOf("recalcul:executions_2026_07")).toBeLessThan(m.ordre.indexOf("retrait:executions_2026_07"));
  });

  it("[A-180] interrupteur fermé : aucun recalcul ni retrait", async () => {
    const m = monde([partition("executions_2026_07", jourIl(95), [CLIENT_A])]);
    await purgerExecutions({ depot: m.depot, gel: m.sansGel, journal: m.ecrire, active: false, maintenant: AUJOURDHUI });
    expect(m.recalculees).toEqual([]);
  });

  it("[C-609] une partition dont la liste de clients est vide est refusée, jamais retirée", async () => {
    const m = monde([partition("executions_2026_07", jourIl(95), [])]);
    const r = await purgerExecutions({ depot: m.depot, gel: m.sansGel, journal: m.ecrire, active: true, maintenant: AUJOURDHUI });
    expect(m.retirees).toEqual([]);
    expect(r.refusees).toEqual([{ partition: "executions_2026_07", motif: "clients_inconnus" }]);
  });

  it("[A-180] une partition VIDE (0 ligne comptée par le rôle de maintenance) est retirée, une liste illisible reste refusée", async () => {
    const m = monde([partition("executions_2026_06", jourIl(120), [], [], 0, 0), partition("executions_2026_07", jourIl(95), [], [], 0, 3)]);
    const r = await purgerExecutions({ depot: m.depot, gel: m.sansGel, journal: m.ecrire, active: true, maintenant: AUJOURDHUI });
    expect(m.retirees).toEqual(["executions_2026_06"]);
    expect(r.refusees).toEqual([{ partition: "executions_2026_07", motif: "clients_inconnus" }]);
  });

  it("[A-180] interrupteur ouvert avec un gel pour litige provisoire (estReel faux) : refus net, rien n'est lu ni retiré", async () => {
    const m = monde([partition("executions_2026_07", jourIl(95), [CLIENT_A])]);
    const provisoire: GelLitige = { estReel: false, gelActif: async () => false };
    await expect(purgerExecutions({ depot: m.depot, gel: provisoire, journal: m.ecrire, active: true, maintenant: AUJOURDHUI })).rejects.toThrow(/provisoire/);
    expect(m.retirees).toEqual([]);
    // Fermé, un gel provisoire reste permis (on ne fait que journaliser).
    await expect(purgerExecutions({ depot: m.depot, gel: provisoire, journal: m.ecrire, active: false, maintenant: AUJOURDHUI })).resolves.toBeDefined();
  });

  it("[A-180] l'intention est écrite au journal avant le retrait, puis le résultat après", async () => {
    const m = monde([partition("executions_2026_07", jourIl(95), [CLIENT_A])]);
    await purgerExecutions({ depot: m.depot, gel: m.sansGel, journal: m.ecrire, active: true, maintenant: AUJOURDHUI });
    expect(m.ordre.indexOf("journal:purge_intention")).toBeLessThan(m.ordre.indexOf("retrait:executions_2026_07"));
    expect(m.ordre.indexOf("retrait:executions_2026_07")).toBeLessThan(m.ordre.indexOf("journal:purge_partition"));
  });

  it("[A-180] si le retrait échoue, l'intention reste au journal et aucun résultat n'est écrit", async () => {
    const m = monde([partition("executions_2026_07", jourIl(95), [CLIENT_A])]);
    m.depot.retirerPartition = async () => {
      throw new Error("panne");
    };
    await expect(purgerExecutions({ depot: m.depot, gel: m.sansGel, journal: m.ecrire, active: true, maintenant: AUJOURDHUI })).rejects.toThrow("panne");
    expect(m.journal.map((e) => e.type)).toEqual(["purge_intention"]);
  });

  it("[A-180] interrupteur fermé : rien n'est retiré et le journal liste ce qui l'aurait été", async () => {
    const m = monde([partition("executions_2026_06", jourIl(120), [CLIENT_A]), partition("executions_2026_07", jourIl(95), [CLIENT_B])]);
    const r = await purgerExecutions({ depot: m.depot, gel: m.sansGel, journal: m.ecrire, active: false, maintenant: AUJOURDHUI });
    expect(m.retirees).toEqual([]);
    expect(r.retirees).toEqual([]);
    expect(m.journal).toEqual([{ type: "purge_prevue_interrupteur_ferme", partitions: ["executions_2026_06", "executions_2026_07"] }]);
  });

  it("[A-180] une partition sans agrégat complet n'est pas retirée", async () => {
    const m = monde([partition("executions_2026_07", jourIl(95), [CLIENT_A], ["2026-07-14"])]);
    const r = await purgerExecutions({ depot: m.depot, gel: m.sansGel, journal: m.ecrire, active: true, maintenant: AUJOURDHUI });
    expect(m.retirees).toEqual([]);
    expect(r.refusees).toEqual([{ partition: "executions_2026_07", motif: "agregat_incomplet" }]);
    expect(m.journal).toContainEqual({ type: "purge_refusee", partition: "executions_2026_07", motif: "agregat_incomplet" });
  });

  it("[C-609] une partition qui contient un client sous gel pour litige n'est pas retirée", async () => {
    const m = monde([partition("executions_2026_07", jourIl(95), [CLIENT_A, CLIENT_B]), partition("executions_2026_06", jourIl(120), [CLIENT_A])]);
    const gel: GelLitige = { estReel: true, gelActif: async (t) => t === CLIENT_B };
    const r = await purgerExecutions({ depot: m.depot, gel, journal: m.ecrire, active: true, maintenant: AUJOURDHUI });
    expect(m.retirees).toEqual(["executions_2026_06"]);
    expect(r.refusees).toEqual([{ partition: "executions_2026_07", motif: "gel_pour_litige" }]);
    expect(m.journal).toContainEqual({ type: "purge_refusee", partition: "executions_2026_07", motif: "gel_pour_litige" });
  });

  it("[C-609] un gel posé pendant la purge est relu juste avant le retrait", async () => {
    const m = monde([partition("executions_2026_07", jourIl(95), [CLIENT_A])]);
    let appels = 0;
    // Libre à la première lecture, posé à la seconde (course entre la pose et le retrait).
    const gel: GelLitige = { estReel: true, gelActif: async () => ++appels > 1 };
    await purgerExecutions({ depot: m.depot, gel, journal: m.ecrire, active: true, maintenant: AUJOURDHUI });
    expect(m.retirees).toEqual([]);
  });

  it("[A-180] aucune partition en dehors de la liste du dépôt n'est retirée, jamais de DELETE par date", async () => {
    const m = monde([]);
    const r = await purgerExecutions({ depot: m.depot, gel: m.sansGel, journal: m.ecrire, active: true, maintenant: AUJOURDHUI });
    expect(r).toEqual({ retirees: [], refusees: [], prevues: [] });
    expect(m.journal).toEqual([]);
  });
});
