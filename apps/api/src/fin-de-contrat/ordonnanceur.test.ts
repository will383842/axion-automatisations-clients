import { readFileSync } from "node:fs";
import { DelayedError } from "bullmq";
import { describe, expect, it } from "vitest";
import { etapeClore, type PlanHub } from "./clore-plans.js";
import { creerMachineFin, idTacheFin, REESSAI_REPONSES_MS, type Dossier, type EtapeFin, type NomEtape, type ResultatFin } from "./machine.js";
import { etapePreavis } from "./preavis.js";
import { balayerFins, deposerTachesFin, REESSAI_GEL_MS, REESSAI_OCCUPE_MS, traiterTacheFin, verrouFin } from "./ordonnanceur.js";
import { verrouConsultatif, type Verrou } from "../provisionnement/machine.js";

const T = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";
const D: Dossier = { dateFin: "2027-03-31", exportReference: null, exportTelechargeLe: null, preavis: { 1: { envoyeLe: null, accuse: null }, 20: { envoyeLe: null, accuse: null }, 27: { envoyeLe: null, accuse: null } } };
const sansGel = { gelActif: async () => false };

function fauxJob(etape: string, tenantId = T) {
  const delais: { quand: number; token?: string | undefined }[] = [];
  return { delais, data: { tenantId, etape }, moveToDelayed: async (quand: number, token?: string) => void delais.push({ quand, token }) };
}
const machineFixe = (r: ResultatFin) => ({ executer: async () => r });
function fausseFile() {
  const jobs = new Map<string, { etat: string; options: Record<string, unknown> }>();
  const ajouts: string[] = [];
  return {
    jobs, ajouts,
    poser: (id: string, etat: string) => void jobs.set(id, { etat, options: {} }),
    getJob: async (id: string) => (jobs.has(id) ? { getState: async () => jobs.get(id)!.etat, remove: async () => void jobs.delete(id) } : undefined),
    add: async (_nom: string, donnees: { tenantId: string; etape: string }, options: Record<string, unknown>) => { ajouts.push(options["jobId"] as string); if (!jobs.has(options["jobId"] as string)) jobs.set(options["jobId"] as string, { etat: "delayed", options: { ...options, donnees } }); },
  };
}

describe("ordonnanceur de la fin de contrat", () => {
  it("[A-250] @argent reprise après une réponse tardive du Hub (horloge injectée) : attend_reponses reporte la même tâche de 15 min sans consommer d'essai, la machine continue au réveil, la clôture n'est déposée qu'une fois et le gel de la base n'a jamais lieu avant la réponse", async () => {
    let horloge = new Date("2027-03-31T23:30:00Z");
    let recue = false;
    const deposes: string[] = [];
    const gele: string[] = [];
    const plans = async (): Promise<PlanHub[]> => [{ idPlan: "plan-1", reponseRecue: recue }];
    const clore = etapeClore({ plans, deposerClore: async (_t, id) => void deposes.push(id), alerter: async () => undefined, gel: sansGel });
    const geler: EtapeFin = { nom: "geler_base", sousGel: false, echeance: () => new Date(0), dejaFait: async () => gele.length > 0, faire: async () => void gele.push("gel") };
    const machine = creerMachineFin({ etapes: [clore, geler], dossier: async () => D, gel: sansGel, alerter: async () => undefined, maintenant: () => horloge });
    const d = { machine, maintenant: () => horloge, gel: sansGel };
    const job = fauxJob("clore_plans");
    await expect(traiterTacheFin(d, job, "jeton")).rejects.toBeInstanceOf(DelayedError);
    expect(job.delais).toEqual([{ quand: horloge.getTime() + REESSAI_REPONSES_MS, token: "jeton" }]);
    expect(gele).toEqual([]);
    expect(deposes).toEqual(["plan-1"]);
    // Réponse tardive : le Hub répond, l'horloge avance, la même tâche est réveillée.
    recue = true;
    horloge = new Date(horloge.getTime() + REESSAI_REPONSES_MS);
    expect(await traiterTacheFin(d, job, "jeton")).toBe("termine");
    expect(gele).toEqual(["gel"]);
    expect(deposes).toEqual(["plan-1"]);
    expect(job.delais).toHaveLength(1);
  });

  it("[A-250] @argent une tâche réveillée avant l'échéance de sa propre étape est redifférée à cette échéance ; une tâche dont l'étape suivante a sa propre tâche se termine", async () => {
    const jusqua = new Date("2027-04-01T22:00:00Z");
    const d = { machine: machineFixe({ etat: "attend_date", etape: "preavis_j1", jusqua }), maintenant: () => new Date("2027-03-31T00:00:00Z"), gel: sansGel };
    const propre = fauxJob("preavis_j1");
    await expect(traiterTacheFin(d, propre, "t")).rejects.toBeInstanceOf(DelayedError);
    expect(propre.delais).toEqual([{ quand: jusqua.getTime(), token: "t" }]);
    const autre = fauxJob("clore_plans");
    expect(await traiterTacheFin(d, autre, "t")).toBe("termine");
    expect(autre.delais).toEqual([]);
    for (const etat of ["a_jour", "en_retard", "dossier_absent"] as const) {
      const r = (etat === "a_jour" ? { etat, etape: "attente_mise_a_l_ecart" } : etat === "en_retard" ? { etat, etape: "preavis_j1" } : { etat }) as ResultatFin;
      expect(await traiterTacheFin({ ...d, machine: machineFixe(r) }, fauxJob("clore_plans"), "t")).toBe("termine");
    }
  });

  it("[C-035] occupe : la tâche est redifférée de 60 s, jamais mise en échec, jamais exécutée en même temps qu'une autre pour le même client", async () => {
    const maintenant = () => new Date("2027-04-01T00:00:00Z");
    const pris = new Set<string>();
    const verrou: Verrou = { prendre: async (t) => (pris.has(t) ? undefined : (pris.add(t), async () => void pris.delete(t))) };
    let ouvrir!: () => void;
    const porte = new Promise<void>((r) => (ouvrir = r));
    let enCours = 0;
    let max = 0;
    const lente: EtapeFin = { nom: "clore_plans", sousGel: false, echeance: () => new Date(0), dejaFait: async () => false, faire: async () => { enCours++; max = Math.max(max, enCours); await porte; enCours--; } };
    const machine = creerMachineFin({ etapes: [lente], dossier: async () => D, gel: sansGel, alerter: async () => undefined, maintenant, verrou });
    const d = { machine, maintenant, gel: sansGel };
    const premiere = traiterTacheFin(d, fauxJob("clore_plans"), "a").catch((e: unknown) => e);
    await new Promise((r) => setTimeout(r, 5));
    const seconde = fauxJob("preavis_j1");
    await expect(traiterTacheFin(d, seconde, "b")).rejects.toBeInstanceOf(DelayedError);
    expect(seconde.delais).toEqual([{ quand: maintenant().getTime() + REESSAI_OCCUPE_MS, token: "b" }]);
    expect(REESSAI_OCCUPE_MS).toBe(60_000);
    ouvrir();
    await premiere;
    expect(max).toBe(1);
  });

  it("[A-255] @envoi suspendu_gel : la tâche est redifférée d'une heure et aucun préavis ne part", async () => {
    const maintenant = () => new Date("2027-04-01T12:00:00Z");
    const envoyes: number[] = [];
    const gel = { gelActif: async () => true };
    const preavis = etapePreavis(1, { envoyer: async (_t, j) => void envoyes.push(j), marquer: async () => undefined, relancer: async () => undefined, gel, maintenant });
    const machine = creerMachineFin({ etapes: [preavis], dossier: async () => D, gel, alerter: async () => undefined, maintenant });
    const job = fauxJob("preavis_j1");
    await expect(traiterTacheFin({ machine, maintenant, gel }, job, "g")).rejects.toBeInstanceOf(DelayedError);
    expect(job.delais).toEqual([{ quand: maintenant().getTime() + REESSAI_GEL_MS, token: "g" }]);
    expect(REESSAI_GEL_MS).toBe(3_600_000);
    expect(envoyes).toEqual([]);
  });

  it("[C-035] le verrou de la fin de contrat a la clé fin-<tenantId> ; celui du provisionnement garde provision-<tenantId>", async () => {
    const cles: unknown[] = [];
    const ouvrir = async () => ({ query: async (_s: string, v: unknown[]) => { cles.push(v[0]); return { rows: [{ ok: true }] }; }, release: () => undefined });
    await (await verrouFin(ouvrir).prendre(T))!();
    await (await verrouConsultatif(ouvrir).prendre(T))!();
    expect(cles).toEqual([`fin-${T}`, `fin-${T}`, `provision-${T}`, `provision-${T}`]);
  });

  it("[C-035] dépôt des tâches : jobId fin-<t>-<étape>, une tâche en échec ou terminée est retirée puis redéposée, une tâche différée ou active est laissée ; le balayage redépose les fins dont la date est dans la fenêtre", async () => {
    const maintenant = () => new Date("2027-03-01T10:00:00Z");
    const file = fausseFile();
    await deposerTachesFin(file, T, "2027-03-31", maintenant);
    const id = (e: NomEtape) => idTacheFin(T, e);
    expect([...file.jobs.keys()].sort()).toEqual((["clore_plans", "preavis_j1", "preavis_j20", "preavis_j27"] as const).map(id).sort());
    expect([...file.jobs.keys()].every((k) => !k.includes(":"))).toBe(true);
    expect(file.jobs.get(id("clore_plans"))!.options["delay"]).toBeGreaterThan(0);
    file.ajouts.length = 0;
    file.poser(id("clore_plans"), "failed");
    file.poser(id("preavis_j1"), "delayed");
    file.poser(id("preavis_j20"), "active");
    file.poser(id("preavis_j27"), "completed");
    await deposerTachesFin(file, T, "2027-03-31", maintenant);
    expect(file.ajouts.sort()).toEqual([id("clore_plans"), id("preavis_j27")].sort());
    const deposes: string[] = [];
    const n = await balayerFins({ fins: async () => [{ tenantId: T, dateFin: "2027-03-31" }, { tenantId: T2, dateFin: "2025-01-01" }], deposer: async (t) => void deposes.push(t), maintenant });
    expect(n).toBe(1);
    expect(deposes).toEqual([T]);
  });

  it("[C-035] @isolation un tenantId ou une étape hors liste dans les données de la tâche est refusé, et ni l'horloge ni la date du système ne sont lues directement", async () => {
    const d = { machine: machineFixe({ etat: "dossier_absent" }), maintenant: () => new Date("2027-04-01T00:00:00Z"), gel: sansGel };
    await expect(traiterTacheFin(d, fauxJob("clore_plans", "pas-un-uuid"), "t")).rejects.toThrow();
    await expect(traiterTacheFin(d, fauxJob("effacer_tout"), "t")).rejects.toThrow();
    await expect(traiterTacheFin(d, fauxJob("attente_mise_a_l_ecart"), "t")).rejects.toThrow();
    for (const f of ["ordonnanceur.ts", "adaptateurs-pg.ts"]) expect(readFileSync(new URL(`./${f}`, import.meta.url), "utf8")).not.toMatch(/Date\.now\(\)|new Date\(\)/);
  });
});
