import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { idTache } from "../files/files.js";
import { DELAI_TROU_MS, FENETRE_RATTRAPAGE_MS, NOM_TACHE, SEUIL_ALERTE_RATTRAPAGES, type FaitRange } from "./recepteur-c2.js";
import { FENETRE_TENTATIVE_MS, balayer, type DepotBalayage } from "./balayage-c2.js";

// Balayage des faits rangés non traités (T2-16b, D1) : la base est la source, la file n'en est qu'une copie.
const CLIENT = "7a1c3e52-0b6d-4c8e-9f41-2d5b8a6c7e10";
const AUTRE = "9b2d4f63-1c7e-4d9f-8a52-3e6c9b7d8f21";
const T0 = 1_800_000_000_000;

type Ligne = FaitRange & { tenantId: string; recuLe: number; traite: boolean };
function depot(lignes: Ligne[]): DepotBalayage {
  return {
    async organisationExiste() { return true; },
    async ranger() { throw new Error("hors sujet"); },
    async etatSujet(tenantId, sujet) {
      const d = lignes.filter((l) => l.tenantId === tenantId && l.sujet === sujet);
      const traitees = d.filter((l) => l.traite).map((l) => l.sequence);
      return { derniereTraitee: traitees.length ? Math.max(...traitees) : null, enAttente: d.filter((l) => !l.traite).map((l) => ({ sequence: l.sequence, recuLe: l.recuLe })) };
    },
    async sujetsEnAttente(limite) {
      const vus = new Map(lignes.filter((l) => !l.traite).map((l) => [`${l.tenantId}|${l.sujet}`, { tenantId: l.tenantId, sujet: l.sujet }]));
      return [...vus.values()].slice(0, limite);
    },
    async faitAttendu(tenantId, sujet, sequence) {
      const l = lignes.find((x) => x.tenantId === tenantId && x.sujet === sujet && x.sequence === sequence && !x.traite);
      return l ? { eventId: l.eventId, type: l.type, sequence: l.sequence, sujet: l.sujet, payload: l.payload } : undefined;
    },
  };
}
const ligne = (sequence: number, extra: Partial<Ligne> = {}): Ligne => ({ tenantId: CLIENT, eventId: randomUUID(), type: "paiement.recu", sequence, sujet: "AXI-CLI-000001", payload: { numeroFacture: "AXI-FACT-000001" }, recuLe: T0 - 60_000, traite: false, ...extra });

function monter(lignes: Ligne[]) {
  const taches: { nom: string; donnees: { eventId?: string; payload?: unknown }; jobId?: string }[] = [];
  const rattrapages: { intention: string }[] = [];
  const alertes: object[] = [];
  const deps = {
    depot: depot(lignes),
    file: { name: "faits-c2", async add(nom: string, donnees: unknown, o?: { jobId?: string }) { taches.push({ nom, donnees: donnees as never, ...(o?.jobId ? { jobId: o.jobId } : {}) }); } },
    rattrapage: { async demander(d: { intention: string }) { rattrapages.push(d); } },
    alerter: (a: object) => void alertes.push(a),
  };
  return { deps, taches, rattrapages, alertes };
}

describe("[C-338] [T2-16b] balayage des faits rangés non traités", () => {
  it("[C-338] [T2-16b] une ligne rangée non traitée est remise en file depuis la base, avec le payload rangé", async () => {
    const l = ligne(0);
    const { deps, taches } = monter([l]);
    expect((await balayer(deps, T0)).remis).toBe(1);
    expect(taches).toHaveLength(1);
    expect(taches[0]?.nom).toBe(NOM_TACHE);
    expect(taches[0]?.donnees).toMatchObject({ tenantId: CLIENT, eventId: l.eventId, sequence: 0, payload: { numeroFacture: "AXI-FACT-000001" } });
  });

  it("[C-338] [T2-16b] le jobId change à chaque tentative (BullMQ ignore un jobId déjà présent) et reste stable dans une même fenêtre", async () => {
    const l = ligne(0);
    const { deps, taches } = monter([l]);
    await balayer(deps, T0);
    await balayer(deps, T0 + 1000);
    await balayer(deps, T0 + FENETRE_TENTATIVE_MS);
    const ids = taches.map((t) => t.jobId);
    expect(ids[0]).toBe(ids[1]);
    expect(ids[2]).not.toBe(ids[0]);
    // Différent de l'identifiant posé à la réception : une tâche échouée de la réception ne bloque pas le balayage.
    expect(ids[0]).not.toBe(idTache({ tenantId: CLIENT, type: NOM_TACHE, cle: l.eventId }));
  });

  it("[C-338] [T2-16b] une ligne traitée, ou un fait qui attend son prédécesseur, n'est pas remis en file", async () => {
    const { deps, taches } = monter([ligne(0, { traite: true }), ligne(2, { recuLe: T0 - 1000 })]);
    expect((await balayer(deps, T0)).remis).toBe(0);
    expect(taches).toHaveLength(0);
  });

  it("[C-338] [T2-16b] un sujet muet avec un trou de plus de 10 minutes déclenche rattrapage et alerte au passage du balayage", async () => {
    const trou = ligne(5, { recuLe: T0 - DELAI_TROU_MS - 1000 });
    const { deps, rattrapages, alertes } = monter([ligne(3, { traite: true }), trou]);
    await balayer(deps, T0);
    expect(rattrapages).toHaveLength(1);
    expect(alertes).toHaveLength(0);
    // Le Hub ne comble jamais le trou : une demande par fenêtre, puis l'alerte (sans identifiant de client), sans qu'aucun fait n'arrive.
    for (let i = 1; i <= SEUIL_ALERTE_RATTRAPAGES; i++) await balayer(deps, T0 + i * FENETRE_RATTRAPAGE_MS);
    expect(alertes.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(alertes)).not.toContain(CLIENT);
  });

  it("[C-338] [T2-16b] une panne sur un sujet n'empêche pas le balayage des autres, et le balayage la signale", async () => {
    const { deps, taches } = monter([ligne(0, { tenantId: AUTRE, sujet: "AXI-CLI-000009" }), ligne(0)]);
    const etat = deps.depot.etatSujet;
    deps.depot.etatSujet = async (t, s) => { if (t === AUTRE) throw new Error("base indisponible"); return etat(t, s); };
    const r = await balayer(deps, T0);
    expect(r).toMatchObject({ remis: 1, erreurs: 1 });
    expect(taches).toHaveLength(1);
  });

  it("[C-338] [T2-16b] le nombre de sujets traités par passage est borné", async () => {
    const lignes = Array.from({ length: 5 }, (_, i) => ligne(0, { sujet: `AXI-CLI-00000${i}` }));
    const { deps, taches } = monter(lignes);
    expect((await balayer(deps, T0, 2)).remis).toBe(2);
    expect(taches).toHaveLength(2);
    await expect(balayer(deps, T0, 0)).rejects.toThrow();
    await expect(balayer(deps, T0, Number.MAX_SAFE_INTEGER + 1)).rejects.toThrow();
  });
});
