import { describe, expect, it } from "vitest";
import { purgerNotes, type DepotNotes, type NoteARetirer } from "./notes.js";
import type { EvenementRetention, GelLitige } from "./purger.js";

const CLIENT_A = "11111111-1111-4111-8111-111111111111";
const CLIENT_B = "22222222-2222-4222-8222-222222222222";
const AUJOURDHUI = new Date("2026-11-02T03:00:00.000Z");

// Notes fictives : seule la date de fin de contrat compte.
const note = (id: string, tenantId: string, finContrat: string): NoteARetirer & { finContrat: string } => ({ id, tenantId, finContrat });

function monde(notes: (NoteARetirer & { finContrat: string })[]) {
  const retirees: string[] = [];
  const journal: EvenementRetention[] = [];
  const depot: DepotNotes = {
    async notesDeContratsFinisAvant(limite) {
      return notes.filter((n) => n.finContrat < limite);
    },
    async retirerNotes(ids) {
      retirees.push(...ids);
    },
  };
  return { depot, retirees, journal, ecrire: async (e: EvenementRetention) => void journal.push(e), sansGel: { gelActif: async () => false } as GelLitige };
}

describe("retrait des notes", () => {
  it("[C-041] une note est gardée 3 ans après la fin du contrat puis retirée, interrupteur ouvert", async () => {
    const m = monde([note("n-gardee", CLIENT_A, "2023-11-03"), note("n-retiree", CLIENT_A, "2023-11-01")]);
    const r = await purgerNotes({ depot: m.depot, gel: m.sansGel, journal: m.ecrire, active: true, maintenant: AUJOURDHUI });
    expect(m.retirees).toEqual(["n-retiree"]);
    expect(r.retirees).toEqual(["n-retiree"]);
  });

  it("[C-041] interrupteur fermé : rien n'est retiré et le journal liste les notes concernées", async () => {
    const m = monde([note("n-retiree", CLIENT_A, "2020-01-01")]);
    await purgerNotes({ depot: m.depot, gel: m.sansGel, journal: m.ecrire, active: false, maintenant: AUJOURDHUI });
    expect(m.retirees).toEqual([]);
    expect(m.journal).toEqual([{ type: "retrait_notes_prevu_interrupteur_ferme", notes: 1 }]);
  });

  it("[C-609] les notes d'un client sous gel pour litige ne sont pas retirées, et le journal le note", async () => {
    const m = monde([note("n-a", CLIENT_A, "2020-01-01"), note("n-b", CLIENT_B, "2020-01-01")]);
    const gel: GelLitige = { gelActif: async (t) => t === CLIENT_B };
    const r = await purgerNotes({ depot: m.depot, gel, journal: m.ecrire, active: true, maintenant: AUJOURDHUI });
    expect(m.retirees).toEqual(["n-a"]);
    expect(r.refusees).toEqual([{ tenantId: CLIENT_B, notes: 1, motif: "gel_pour_litige" }]);
    expect(m.journal).toContainEqual({ type: "retrait_notes_refuse", tenantId: CLIENT_B, notes: 1, motif: "gel_pour_litige" });
  });
});
