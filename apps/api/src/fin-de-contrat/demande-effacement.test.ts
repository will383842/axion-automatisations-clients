import { describe, expect, it } from "vitest";
import type { AlerteFin } from "./machine.js";
import type { Validation } from "./mettre-a-l-ecart.js";
import { deciderEffacement, enregistrerDemandeEffacement } from "./demande-effacement.js";
import type { SessionDecision } from "./decision-proposition.js";

const A = "11111111-1111-4111-8111-111111111111";
const D1 = "99999999-9999-4999-8999-999999999999";
const G1 = "77777777-7777-4777-8777-777777777777";
const NOW = new Date("2029-03-01T10:00:00Z");
const session = (o: Partial<SessionDecision> = {}): SessionDecision => ({ acteur: "will", role: "will", reauthLe: new Date(NOW.getTime() - 60_000), jetonId: `j${Math.random()}`, ...o });

function monter(o: { gelsActifs?: string[]; gel?: boolean } = {}) {
  const alertes: AlerteFin[] = [];
  const validations: Validation[] = [];
  const jobs: string[] = [];
  const motifsClient: string[] = [];
  const refus: unknown[] = [];
  let etat = "en_attente";
  const suppressions: string[] = [];
  const p = {
    gel: { gelActif: async () => o.gel ?? false },
    gelActifId: async (_t: string, g: string) => (o.gelsActifs ?? []).includes(g),
    maintenant: () => NOW,
    alerter: async (a: AlerteFin) => void alertes.push(a),
    creer: async () => ({ id: D1 }),
    demande: async (t: string, id: string) => (t === A && id === D1 ? { id, tenantId: t, etat } : undefined),
    informerClient: async (_t: string, motif: string) => void motifsClient.push(motif),
    transaction: async <T>(_id: string, fn: (tx: unknown) => Promise<T>): Promise<T> => fn({
      gelActif: async () => o.gel ?? false,
      ajouterValidation: async (v: Validation) => { if (validations.some((x) => x.jetonId === v.jetonId)) return false; validations.push(v); return true; },
      validations: async () => validations,
      poserAcceptee: async () => { if (etat !== "en_attente") return false; etat = "acceptee"; return true; },
      poserRefusee: async (r: unknown) => { refus.push(r); etat = "refusee"; return true; },
      mettreEnFile: async (j: string) => void jobs.push(j),
    }),
  };
  return { p: p as never, alertes, validations, jobs, motifsClient, refus, suppressions, etat: () => etat };
}

describe("demande écrite d'effacement et décision", () => {
  it("[C-623] une demande écrite seule crée une demande en attente, alerte Will et ne supprime rien", async () => {
    const m = monter();
    const r = await enregistrerDemandeEffacement(m.p, A, "suivi/ecrit-0001");
    expect(r).toEqual({ id: D1 });
    expect(m.alertes.map((a) => a.type)).toEqual(["demande_effacement"]);
    expect(m.jobs).toEqual([]);
    expect(m.etat()).toBe("en_attente");
    await expect(enregistrerDemandeEffacement(m.p, A, "  ")).rejects.toMatchObject({ code: "schema_invalide" });
  });
  it("[C-623] l'effacement exige la même double validation : deux décisions de Will à 24 h, ou Will + le second administrateur", async () => {
    const m = monter();
    expect(await deciderEffacement(m.p, A, D1, { action: "accepter" }, session())).toBe("validation_enregistree");
    expect(m.jobs).toEqual([]);
    expect(await deciderEffacement(m.p, A, D1, { action: "accepter" }, session({ acteur: "second", role: "second_administrateur" }))).toBe("acceptee");
    expect(m.jobs).toEqual([`effacement-demande-${D1}`]);
    await expect(deciderEffacement(monter().p, A, D1, { action: "accepter" }, session({ reauthLe: null }))).rejects.toMatchObject({ code: "reauthentification_requise" });
  });
  it("[C-715] le refus d'une demande sans litige ni obligation légale est rejeté, comme un refus sans motif", async () => {
    const m = monter();
    await expect(deciderEffacement(m.p, A, D1, { action: "refuser", cause: "decision_de_will" as never, motif: "non" }, session())).rejects.toMatchObject({ code: "regle_metier" });
    await expect(deciderEffacement(m.p, A, D1, { action: "refuser", cause: "obligation_legale", referenceTexte: "article x", motif: " " }, session())).rejects.toMatchObject({ code: "schema_invalide" });
    expect(m.etat()).toBe("en_attente");
  });
  it("[C-715] le refus pour litige exige un gel actif et un motif écrit communiqué au client ; pour obligation légale, une référence écrite", async () => {
    const sans = monter();
    await expect(deciderEffacement(sans.p, A, D1, { action: "refuser", cause: "litige_en_cours", gelId: G1, motif: "litige" }, session())).rejects.toMatchObject({ code: "regle_metier" });
    const avec = monter({ gelsActifs: [G1] });
    await deciderEffacement(avec.p, A, D1, { action: "refuser", cause: "litige_en_cours", gelId: G1, motif: "litige en cours" }, session());
    expect(avec.etat()).toBe("refusee");
    expect(avec.motifsClient).toEqual(["litige en cours"]);
    const loi = monter();
    await expect(deciderEffacement(loi.p, A, D1, { action: "refuser", cause: "obligation_legale", referenceTexte: " ", motif: "m" }, session())).rejects.toMatchObject({ code: "regle_metier" });
    await deciderEffacement(loi.p, A, D1, { action: "refuser", cause: "obligation_legale", referenceTexte: "texte cité", motif: "m" }, session());
    expect(loi.etat()).toBe("refusee");
    await expect(deciderEffacement(monter().p, A, D1, { action: "refuser", cause: "obligation_legale", referenceTexte: "t", motif: "m" }, session({ role: "second_administrateur" }))).rejects.toMatchObject({ code: "action_interdite" });
  });
  it("[C-623] une décision sans demande écrite existante, ou pour un autre client, est refusée", async () => {
    await expect(deciderEffacement(monter().p, "22222222-2222-4222-8222-222222222222", D1, { action: "accepter" }, session())).rejects.toMatchObject({ code: "introuvable" });
  });
  it("[C-609] un gel actif bloque la décision d'accepter", async () => {
    const m = monter({ gel: true });
    await expect(deciderEffacement(m.p, A, D1, { action: "accepter" }, session())).rejects.toMatchObject({ code: "regle_metier" });
    expect(m.validations).toEqual([]);
  });
});
