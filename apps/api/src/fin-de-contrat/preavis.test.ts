import { describe, expect, it } from "vitest";
import { ETAPES, echeance, type Dossier } from "./machine.js";
import { etapeExporter, etapePreavis, etatPreuve } from "./preavis.js";

const T = "11111111-1111-4111-8111-111111111111";
const base = (): Dossier => ({ dateFin: "2027-01-10", exportReference: null, exportTelechargeLe: null, preavis: { 1: { envoyeLe: null, accuse: null }, 20: { envoyeLe: null, accuse: null }, 27: { envoyeLe: null, accuse: null } } });

function monter(o: { gel?: boolean; echecEnvoi?: boolean } = {}) {
  const dossier = base();
  const journal: string[] = [];
  const relances: string[] = [];
  const maintenant = new Date("2027-02-06T23:00:00Z");
  const etape = (jour: 1 | 20 | 27) => etapePreavis(jour, {
    envoyer: async (_t, j) => { if (o.echecEnvoi) throw new Error("panne"); journal.push(`envoi:${j}`); },
    marquer: async (_t, j, quand) => { dossier.preavis[j].envoyeLe = dossier.preavis[j].envoyeLe ?? quand; },
    relancer: async (_t, j) => void relances.push(`relance:${j}`),
    gel: { gelActif: async () => o.gel === true },
    maintenant: () => maintenant,
  });
  return { dossier, journal, relances, etape };
}

describe("préavis écrits", () => {
  it("[A-255] @envoi les trois préavis partent à J+1, J+20 et J+27 et sont tracés avec leur preuve", async () => {
    const m = monter();
    expect(ETAPES.slice(3, 6)).toEqual(["preavis_j1", "preavis_j20", "preavis_j27"]);
    for (const j of [1, 20, 27] as const) {
      const e = m.etape(j);
      expect(e.echeance?.(m.dossier)).toEqual(echeance("2027-01-10", j));
      await e.faire(T, m.dossier);
      expect(await e.dejaFait(T, m.dossier)).toBe(true);
      expect(m.dossier.preavis[j].envoyeLe).toEqual(new Date("2027-02-06T23:00:00Z"));
    }
    expect(m.journal).toEqual(["envoi:1", "envoi:20", "envoi:27"]);
  });

  it("[A-255] @envoi un préavis rejoué ne part qu'une fois", async () => {
    const m = monter();
    const e = m.etape(20);
    await e.faire(T, m.dossier);
    const premiere = m.dossier.preavis[20].envoyeLe;
    // La tâche est rejouée : l'étape est déjà faite, la machine ne la rappelle pas ; même rappelée, la date d'envoi ne bouge pas.
    expect(await e.dejaFait(T, m.dossier)).toBe(true);
    await e.faire(T, m.dossier);
    expect(m.dossier.preavis[20].envoyeLe).toBe(premiere);
    // Un envoi qui échoue ne marque rien : le rejeu enverra.
    const panne = monter({ echecEnvoi: true });
    await expect(panne.etape(1).faire(T, panne.dossier)).rejects.toThrow();
    expect(panne.dossier.preavis[1].envoyeLe).toBeNull();
  });

  it("[A-255] un préavis envoyé sans accusé n'est pas compté comme prouvé", () => {
    expect(etatPreuve({ envoyeLe: null, accuse: null })).toBe("non_envoye");
    expect(etatPreuve({ envoyeLe: new Date(), accuse: null })).toBe("envoye_sans_accuse");
    expect(etatPreuve({ envoyeLe: new Date(), accuse: "  " })).toBe("envoye_sans_accuse");
    expect(etatPreuve({ envoyeLe: null, accuse: "recu:2027-01-11T10:00:00.000Z" })).toBe("non_envoye");
    expect(etatPreuve({ envoyeLe: new Date(), accuse: "recu:2027-01-11T10:00:00.000Z" })).toBe("prouve");
  });

  it("[A-255] la relance téléphonique est proposée si l'export n'est pas téléchargé (à J+20 et J+27, jamais à J+1)", async () => {
    const m = monter();
    for (const j of [1, 20, 27] as const) await m.etape(j).faire(T, m.dossier);
    expect(m.relances).toEqual(["relance:20", "relance:27"]);
    const telecharge = monter();
    telecharge.dossier.exportTelechargeLe = new Date("2027-01-15T10:00:00Z");
    for (const j of [1, 20, 27] as const) await telecharge.etape(j).faire(T, telecharge.dossier);
    expect(telecharge.relances).toEqual([]);
  });

  it("[C-609] pendant un gel, aucun préavis ne part", async () => {
    const m = monter({ gel: true });
    await expect(m.etape(1).faire(T, m.dossier)).rejects.toMatchObject({ motif: "gel_pour_litige" });
    expect(m.journal).toEqual([]);
    expect(m.dossier.preavis[1].envoyeLe).toBeNull();
  });

  it("[C-035] l'export complet est préparé une seule fois et sa référence et son expiration sont gardées", async () => {
    const d = base();
    const lances: string[] = [];
    const e = etapeExporter({ lancer: async (t) => { lances.push(t); return { reference: "exports/e1.zip", expireLe: new Date("2027-02-09T00:00:00Z") }; }, enregistrer: async (_t, ref) => { d.exportReference = ref; }, gel: { gelActif: async () => false } });
    expect(await e.dejaFait(T, d)).toBe(false);
    await e.faire(T, d);
    expect(await e.dejaFait(T, d)).toBe(true);
    expect(d.exportReference).toBe("exports/e1.zip");
    expect(lances).toEqual([T]);
  });
});
