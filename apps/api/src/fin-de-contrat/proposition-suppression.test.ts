import { describe, expect, it } from "vitest";
import { ErreurApi } from "../plugins/erreurs.js";
import type { AlerteFin } from "./machine.js";
import { ajouterMois, creerPropositionSuppression, idTachePropositionSuppression, rappelerPropositions } from "./proposition-suppression.js";

const A = "11111111-1111-4111-8111-111111111111";
const FIN = "33333333-3333-4333-8333-333333333333";
const FIN2 = "44444444-4444-4444-8444-444444444444";
const fin = { id: FIN, tenantId: A, dateFin: "2027-01-10" };

function monter(o: { delai?: number; maintenant?: string; gel?: boolean } = {}) {
  const lignes: { id: string; tenantId: string; finDeContratId: string; echeance: string; avisEnvoyeLe: Date | null }[] = [];
  const alertes: AlerteFin[] = [];
  const suppressions: string[] = [];
  let maintenant = new Date(o.maintenant ?? "2029-01-11T10:00:00Z");
  const p = {
    delaiMois: async () => o.delai ?? 24,
    // INSERT … ON CONFLICT (tenant_id, fin_de_contrat_id, echeance) DO NOTHING
    inserer: async (n: { tenantId: string; finDeContratId: string; echeance: string }) => {
      const e = lignes.find((l) => l.tenantId === n.tenantId && l.finDeContratId === n.finDeContratId && l.echeance === n.echeance);
      if (e) return { id: e.id, cree: false, avisEnvoyeLe: e.avisEnvoyeLe };
      lignes.push({ id: `p${lignes.length}`, ...n, avisEnvoyeLe: null });
      return { id: `p${lignes.length - 1}`, cree: true, avisEnvoyeLe: null };
    },
    envoyerAvis: async () => undefined,
    marquerAvis: async (id: string, quand: Date) => { const l = lignes.find((x) => x.id === id); if (l) l.avisEnvoyeLe ??= quand; },
    enAttente: async () => lignes.map((l) => ({ id: l.id, tenantId: l.tenantId, avisEnvoyeLe: l.avisEnvoyeLe })),
    gel: { gelActif: async () => o.gel ?? false },
    alerter: async (a: AlerteFin) => void alertes.push(a),
    maintenant: () => maintenant,
  };
  return { p, lignes, alertes, suppressions, avancer: (iso: string) => { maintenant = new Date(iso); } };
}

describe("proposition de suppression", () => {
  it("[C-715] 24 mois après la fin, une proposition en attente est créée une seule fois, Will est alerté, le client est avisé, rien n'est supprimé", async () => {
    const { p, lignes, alertes } = monter();
    expect(await creerPropositionSuppression(p, fin)).toBe("creee");
    expect(await creerPropositionSuppression(p, fin)).toBe("existante");
    expect(lignes).toHaveLength(1);
    expect(lignes[0]?.echeance).toBe("2029-01-10");
    expect(lignes[0]?.avisEnvoyeLe).not.toBeNull();
    expect(alertes.map((a) => a.code)).toContain("proposition_en_attente_2029-01-11");
    await rappelerPropositions(p);
    expect(alertes.filter((a) => a.code === "proposition_en_attente_2029-01-11").length).toBeGreaterThanOrEqual(1);
  });
  it("[C-715] avant l'échéance, rien n'est créé", async () => {
    const { p, lignes } = monter({ maintenant: "2029-01-09T10:00:00Z" });
    expect(await creerPropositionSuppression(p, fin)).toBe("pas_encore");
    expect(lignes).toEqual([]);
  });
  it("[C-715] le délai est lu en base : 18 ou 36 mois changent l'échéance ; sous 2 mois, refusé", async () => {
    expect(ajouterMois("2027-01-10", 18)).toBe("2028-07-10");
    expect(ajouterMois("2027-01-31", 25)).toBe("2029-02-28");
    const dix8 = monter({ delai: 18, maintenant: "2028-07-10T12:00:00Z" });
    expect(await creerPropositionSuppression(dix8.p, fin)).toBe("creee");
    expect(dix8.lignes[0]?.echeance).toBe("2028-07-10");
    const trente6 = monter({ delai: 36, maintenant: "2029-01-11T10:00:00Z" });
    expect(await creerPropositionSuppression(trente6.p, fin)).toBe("pas_encore");
    for (const d of [0, 1, -5, 2.5, Number.NaN]) await expect(creerPropositionSuppression(monter({ delai: d }).p, fin)).rejects.toBeInstanceOf(ErreurApi);
  });
  it("[C-715] deux tâches pour la même échéance créent une seule ligne ; la 2e fin de contrat du même client crée la sienne", async () => {
    const { p, lignes } = monter();
    const [a, b] = await Promise.all([creerPropositionSuppression(p, fin), creerPropositionSuppression(p, fin)]);
    expect([a, b].sort()).toEqual(["creee", "existante"]);
    await creerPropositionSuppression(p, { ...fin, id: FIN2 });
    expect(lignes).toHaveLength(2);
    expect(idTachePropositionSuppression(FIN, "2029-01-10")).toBe(`proposition-${FIN}-2029-01-10`);
    expect(idTachePropositionSuppression(FIN, "2029-01-10")).not.toContain(":");
    expect(() => idTachePropositionSuppression("x:y", "2029-01-10")).toThrow();
  });
  it("[A-256] sans clic de Will, 24 mois ou 24 mois + 400 jours plus tard, il n'y a qu'une proposition en attente et rien n'est supprimé", async () => {
    const { p, lignes, suppressions, avancer } = monter();
    for (const quand of ["2029-01-11T10:00:00Z", "2030-02-15T10:00:00Z", "2030-02-16T10:00:00Z"]) { avancer(quand); await creerPropositionSuppression(p, fin); await rappelerPropositions(p); }
    expect(lignes).toHaveLength(1);
    expect(suppressions).toEqual([]);
  });
  it("[C-609] pendant un gel, la proposition existe mais l'avis au client ne part pas", async () => {
    const { p, lignes } = monter({ gel: true });
    await creerPropositionSuppression(p, fin);
    expect(lignes[0]?.avisEnvoyeLe).toBeNull();
  });
});
