import { describe, expect, it } from "vitest";
import { proposerSuppressionNotes, type DepotNotes, type NoteEnFinDeContrat, type PropositionSuppression } from "./notes.js";
import type { EvenementRetention, GelLitige } from "./purger.js";

const CLIENT_A = "11111111-1111-4111-8111-111111111111";
const CLIENT_B = "22222222-2222-4222-8222-222222222222";
const AUJOURDHUI = new Date("2026-11-02T03:00:00.000Z");

// Notes fictives : seule la date de fin de contrat compte.
const note = (id: string, tenantId: string, finContrat: string): NoteEnFinDeContrat => ({ id, tenantId, finContrat });

function monde(notes: NoteEnFinDeContrat[], nouveauContrat: string[] = []) {
  const propositions: PropositionSuppression[] = [];
  const journal: EvenementRetention[] = [];
  const depot: DepotNotes = {
    async notesDeContratsFinisAvant(limite) {
      return notes.filter((n) => n.finContrat < limite);
    },
    async nouveauContratApres(tenantId) {
      return nouveauContrat.includes(tenantId);
    },
    // Contrat du port : idempotente sur (client, date de fin).
    async soumettreProposition(p) {
      if (propositions.some((x) => x.tenantId === p.tenantId && x.finContrat === p.finContrat)) return false;
      propositions.push(p);
      return true;
    },
  };
  return { depot, propositions, journal, ecrire: async (e: EvenementRetention) => void journal.push(e), sansGel: { estReel: true, gelActif: async () => false } };
}

describe("fin de conservation des notes : proposition à Will, jamais d'effacement", () => {
  it("[C-041] le port n'offre aucun moyen d'effacer une note", () => {
    const m = monde([]);
    expect(Object.keys(m.depot).sort()).toEqual(["notesDeContratsFinisAvant", "nouveauContratApres", "soumettreProposition"]);
  });

  it("[C-041] 3 ans après la fin du contrat, une proposition par client liste les identifiants et la date de fin", async () => {
    const m = monde([note("n-gardee", CLIENT_A, "2023-11-03"), note("n-1", CLIENT_B, "2023-11-01"), note("n-2", CLIENT_B, "2022-05-01")]);
    const r = await proposerSuppressionNotes({ depot: m.depot, gel: m.sansGel, journal: m.ecrire, active: true, maintenant: AUJOURDHUI });
    expect(m.propositions).toEqual([{ tenantId: CLIENT_B, noteIds: ["n-1", "n-2"], finContrat: "2023-11-01" }]);
    expect(r.proposees).toEqual(m.propositions);
    expect(m.journal).toContainEqual({ type: "proposition_suppression_notes", tenantId: CLIENT_B, noteIds: ["n-1", "n-2"], finContrat: "2023-11-01" });
  });

  it("[C-041] deux passages (deux nuits) donnent une seule proposition et une seule ligne au journal", async () => {
    const m = monde([note("n-1", CLIENT_B, "2023-11-01")]);
    const o = { depot: m.depot, gel: m.sansGel, journal: m.ecrire, active: true, maintenant: AUJOURDHUI };
    const premier = await proposerSuppressionNotes(o);
    const second = await proposerSuppressionNotes(o);
    expect(premier.proposees).toHaveLength(1);
    expect(second.proposees).toEqual([]);
    expect(m.propositions).toHaveLength(1);
    expect(m.journal.filter((e) => e.type === "proposition_suppression_notes")).toHaveLength(1);
  });

  it("[C-609] interrupteur ouvert avec un gel provisoire (estReel faux) : refus net, aucune proposition", async () => {
    const m = monde([note("n-1", CLIENT_B, "2023-11-01")]);
    await expect(proposerSuppressionNotes({ depot: m.depot, gel: { estReel: false, gelActif: async () => false }, journal: m.ecrire, active: true, maintenant: AUJOURDHUI })).rejects.toThrow(/provisoire/);
    expect(m.propositions).toEqual([]);
  });

  it("[C-041] un client qui a signé un nouveau contrat n'est pas proposé", async () => {
    const m = monde([note("n-a", CLIENT_A, "2020-01-01"), note("n-b", CLIENT_B, "2020-01-01")], [CLIENT_A]);
    await proposerSuppressionNotes({ depot: m.depot, gel: m.sansGel, journal: m.ecrire, active: true, maintenant: AUJOURDHUI });
    expect(m.propositions.map((p) => p.tenantId)).toEqual([CLIENT_B]);
  });

  it("[C-041] interrupteur fermé : aucune proposition soumise, le journal liste ce qui le serait", async () => {
    const m = monde([note("n-a", CLIENT_A, "2020-01-01")]);
    await proposerSuppressionNotes({ depot: m.depot, gel: m.sansGel, journal: m.ecrire, active: false, maintenant: AUJOURDHUI });
    expect(m.propositions).toEqual([]);
    expect(m.journal).toEqual([{ type: "proposition_notes_prevue_interrupteur_ferme", tenantId: CLIENT_A, noteIds: ["n-a"], finContrat: "2020-01-01" }]);
  });

  it("[C-609] un client sous gel pour litige n'est pas proposé, et le journal le note", async () => {
    const m = monde([note("n-a", CLIENT_A, "2020-01-01"), note("n-b", CLIENT_B, "2020-01-01")]);
    const gel: GelLitige = { estReel: true, gelActif: async (t) => t === CLIENT_B };
    const r = await proposerSuppressionNotes({ depot: m.depot, gel, journal: m.ecrire, active: true, maintenant: AUJOURDHUI });
    expect(m.propositions.map((p) => p.tenantId)).toEqual([CLIENT_A]);
    expect(r.refusees).toEqual([{ tenantId: CLIENT_B, notes: 1, motif: "gel_pour_litige" }]);
    expect(m.journal).toContainEqual({ type: "proposition_notes_refusee", tenantId: CLIENT_B, notes: 1, motif: "gel_pour_litige" });
  });

  it("[C-609] le gel est relu juste avant la proposition : un gel posé entre-temps l'emporte", async () => {
    const m = monde([note("n-a", CLIENT_A, "2020-01-01")]);
    let appels = 0;
    const gel: GelLitige = { estReel: true, gelActif: async () => ++appels > 1 };
    await proposerSuppressionNotes({ depot: m.depot, gel, journal: m.ecrire, active: true, maintenant: AUJOURDHUI });
    expect(m.propositions).toEqual([]);
  });

  it("[C-041] le journal ne contient jamais le texte d'une note", async () => {
    const m = monde([{ ...note("n-a", CLIENT_A, "2020-01-01"), texte: "contenu confidentiel" } as NoteEnFinDeContrat]);
    await proposerSuppressionNotes({ depot: m.depot, gel: m.sansGel, journal: m.ecrire, active: true, maintenant: AUJOURDHUI });
    expect(JSON.stringify(m.journal)).not.toContain("confidentiel");
  });
});
