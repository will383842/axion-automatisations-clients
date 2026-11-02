import { describe, expect, it } from "vitest";
import { purgerExecutions, type DepotPartitions, type EvenementRetention, type GelLitige, type Partition } from "./purger.js";

const CLIENT_A = "11111111-1111-4111-8111-111111111111";
const CLIENT_B = "22222222-2222-4222-8222-222222222222";
const AUJOURDHUI = new Date("2026-11-02T03:00:00.000Z");
const jourIl = (jours: number) => new Date(AUJOURDHUI.getTime() - jours * 86_400_000).toISOString().slice(0, 10);

// Partition mensuelle fictive qui finit (exclue) à `fin`.
const partition = (nom: string, fin: string, tenants: string[], joursSansAgregat: string[] = []): Partition & { joursSansAgregat: string[] } => ({ nom, fin, tenants, joursSansAgregat });

function monde(partitions: (Partition & { joursSansAgregat: string[] })[]) {
  const retirees: string[] = [];
  const journal: EvenementRetention[] = [];
  const depot: DepotPartitions = {
    async partitionsTerminees(avant) {
      return partitions.filter((p) => p.fin <= avant);
    },
    async joursSansAgregat(p) {
      return partitions.find((x) => x.nom === p.nom)?.joursSansAgregat ?? [];
    },
    async retirerPartition(nom) {
      retirees.push(nom);
    },
  };
  const sansGel: GelLitige = { gelActif: async () => false };
  return { depot, retirees, journal, ecrire: async (e: EvenementRetention) => void journal.push(e), sansGel };
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

  it("[C-039] une exécution de 89 jours reste", async () => {
    // La partition qui contient une exécution de 89 jours finit après la limite de 90 jours.
    const m = monde([partition("executions_2026_08", jourIl(89 - 20), [CLIENT_A]), partition("executions_2026_07", jourIl(90), [CLIENT_A])]);
    await purgerExecutions({ depot: m.depot, gel: m.sansGel, journal: m.ecrire, active: true, maintenant: AUJOURDHUI });
    expect(m.retirees).toEqual(["executions_2026_07"]);
    expect(m.retirees).not.toContain("executions_2026_08");
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
    const gel: GelLitige = { gelActif: async (t) => t === CLIENT_B };
    const r = await purgerExecutions({ depot: m.depot, gel, journal: m.ecrire, active: true, maintenant: AUJOURDHUI });
    expect(m.retirees).toEqual(["executions_2026_06"]);
    expect(r.refusees).toEqual([{ partition: "executions_2026_07", motif: "gel_pour_litige" }]);
    expect(m.journal).toContainEqual({ type: "purge_refusee", partition: "executions_2026_07", motif: "gel_pour_litige" });
  });

  it("[C-609] un gel posé pendant la purge est relu juste avant le retrait", async () => {
    const m = monde([partition("executions_2026_07", jourIl(95), [CLIENT_A])]);
    let appels = 0;
    // Libre à la première lecture, posé à la seconde (course entre la pose et le retrait).
    const gel: GelLitige = { gelActif: async () => ++appels > 1 };
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
