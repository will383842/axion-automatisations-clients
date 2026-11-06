import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ErreurApi } from "../plugins/erreurs.js";
import { GelPourLitige } from "../gel/garde.js";
import { ETAPES, TOLERANCE_RETARD_MS, ajouterJours, creerMachineFin, echeance, idTacheFin, planifierTaches, recevoirDemandeEffacement, type AlerteFin, type Dossier, type EtapeFin } from "./machine.js";
import { etapeClore } from "./clore-plans.js";
import { etapeGeler } from "./geler.js";
import { etapeExporter, etapePreavis } from "./preavis.js";
import type { LigneBase } from "../provisionnement/machine.js";

const T = "11111111-1111-4111-8111-111111111111";
const DATE_FIN = "2027-01-10";
const dossierVide = (): Dossier => ({ dateFin: DATE_FIN, exportReference: null, exportTelechargeLe: null, preavis: { 1: { envoyeLe: null, accuse: null }, 20: { envoyeLe: null, accuse: null }, 27: { envoyeLe: null, accuse: null } } });

// Étapes factices : chacune note son passage et peut rester « pas finie » (réponses du Hub non reçues).
function monter(o: { gel?: () => boolean; reponsesRecues?: () => boolean } = {}) {
  const faits = new Set<string>();
  const appels: string[] = [];
  const alertes: AlerteFin[] = [];
  let maintenant = new Date("2027-01-10T08:00:00Z");
  const etape = (nom: string, jours = 0): EtapeFin => ({
    nom,
    sousGel: nom === "exporter" || nom.startsWith("preavis"),
    echeance: () => echeance(DATE_FIN, jours),
    limite: nom.startsWith("preavis") ? () => new Date(echeance(DATE_FIN, jours).getTime() + TOLERANCE_RETARD_MS) : undefined,
    dejaFait: async () => faits.has(nom),
    faire: async () => { appels.push(nom); if (nom !== "clore_plans" || (o.reponsesRecues?.() ?? true)) faits.add(nom); },
  });
  const machine = creerMachineFin({
    etapes: [etape("clore_plans"), etape("geler_base"), etape("exporter"), etape("preavis_j1", 1), etape("preavis_j20", 20), etape("preavis_j27", 27)],
    dossier: async () => dossierVide(),
    gel: { gelActif: async () => o.gel?.() ?? false },
    alerter: async (a) => void alertes.push(a),
    maintenant: () => maintenant,
  });
  return { machine, appels, alertes, avancer: (iso: string) => { maintenant = new Date(iso); } };
}

describe("dates de la fin de contrat", () => {
  it("[A-255] J+1, J+20 et J+27 sont des jours calendaires depuis la date de fin, à minuit Europe/Paris, y compris au passage à l'heure d'été", () => {
    expect(ajouterJours("2027-01-10", 20)).toBe("2027-01-30");
    expect(ajouterJours("2027-02-20", 20)).toBe("2027-03-12");
    expect(echeance("2027-01-10", 1).toISOString()).toBe("2027-01-10T23:00:00.000Z"); // hiver : minuit Paris = 23 h UTC la veille
    // Fin le 2027-03-10 : J+20 = 30 mars (été, UTC+2), J+27 = 6 avril ; le 28 mars 2027 est le changement d'heure.
    expect(echeance("2027-03-10", 20).toISOString()).toBe("2027-03-29T22:00:00.000Z");
    expect(echeance("2027-03-27", 1).toISOString()).toBe("2027-03-27T23:00:00.000Z");
    expect(echeance("2027-03-28", 1).toISOString()).toBe("2027-03-28T22:00:00.000Z");
    expect(echeance("2027-10-20", 10).toISOString()).toBe("2027-10-29T22:00:00.000Z");
    expect(echeance("2027-10-20", 8).toISOString()).toBe("2027-10-27T22:00:00.000Z");
    expect(echeance("2027-10-20", 9).toISOString()).toBe("2027-10-28T22:00:00.000Z");
  });
});

describe("machine de fin de contrat", () => {
  it("[C-035] la fin de contrat clôture, exporte et prouve le préavis ; la dernière étape est l'attente de mise à l'écart", async () => {
    expect(ETAPES).toEqual(["clore_plans", "geler_base", "exporter", "preavis_j1", "preavis_j20", "preavis_j27", "attente_mise_a_l_ecart"]);
    const m = monter();
    expect(await m.machine.executer(T)).toMatchObject({ etat: "attend_date", etape: "preavis_j1" });
    expect(m.appels).toEqual(["clore_plans", "geler_base", "exporter"]);
    m.avancer("2027-01-11T00:00:00Z");
    expect((await m.machine.executer(T)).etat).toBe("attend_date");
    m.avancer("2027-01-29T23:00:00Z");
    expect((await m.machine.executer(T)).etat).toBe("attend_date");
    m.avancer("2027-02-05T23:00:00Z");
    expect(await m.machine.executer(T)).toEqual({ etat: "a_jour", etape: "attente_mise_a_l_ecart" });
    expect(m.appels).toEqual(["clore_plans", "geler_base", "exporter", "preavis_j1", "preavis_j20", "preavis_j27"]);
    // Rejeu : rien n'est refait.
    await m.machine.executer(T);
    expect(m.appels).toHaveLength(6);
  });

  it("[A-250] @argent l'étape suivante ne démarre pas tant que toutes les réponses du Hub ne sont pas reçues", async () => {
    let recues = false;
    const m = monter({ reponsesRecues: () => recues });
    expect(await m.machine.executer(T)).toMatchObject({ etat: "attend_reponses", etape: "clore_plans" });
    expect(m.appels).toEqual(["clore_plans"]);
    recues = true;
    await m.machine.executer(T);
    expect(m.appels.slice(0, 3)).toEqual(["clore_plans", "clore_plans", "geler_base"]);
  });

  it("[C-609] pendant un gel, aucun préavis ni export ne part ; la reprise a lieu après la levée", async () => {
    let gel = true;
    const m = monter({ gel: () => gel });
    m.avancer("2027-01-10T23:00:00Z");
    expect(await m.machine.executer(T)).toMatchObject({ etat: "suspendu_gel", etape: "exporter" });
    expect(m.appels).toEqual(["clore_plans", "geler_base"]);
    gel = false;
    await m.machine.executer(T);
    expect(m.appels).toEqual(["clore_plans", "geler_base", "exporter", "preavis_j1"]);
    expect(new GelPourLitige("preavis").motif).toBe("gel_pour_litige");
  });

  it("[C-609] @argent un gel pour litige ne suspend ni la clôture des plans du Hub ni le gel de la base : la facturation s'arrête quand même", async () => {
    const deposes: string[] = [];
    const alertes: AlerteFin[] = [];
    const base = { etat: "active" as LigneBase["etat"] };
    const plans = [{ idPlan: "plan-1", reponseRecue: false }];
    const gel = { gelActif: async () => true };
    const machine = creerMachineFin({
      etapes: [
        etapeClore({ plans: async () => plans, deposerClore: async (_t, id) => { deposes.push(id); plans[0]!.reponseRecue = true; }, alerter: async (a) => void alertes.push(a), gel }),
        etapeGeler({ etatBase: async () => base.etat, geler: async () => { base.etat = "gelee"; }, pauserInstances: async () => undefined, instancesActives: async () => 0, emettreResilie: async () => undefined, alerter: async (a) => void alertes.push(a), gel }),
        etapeExporter({ lancer: async () => { throw new Error("jamais : export suspendu par le gel"); }, enregistrer: async () => undefined, gel }),
      ],
      dossier: async () => dossierVide(),
      gel,
      alerter: async (a) => void alertes.push(a),
      maintenant: () => new Date("2027-01-10T08:00:00Z"),
    });
    expect(await machine.executer(T)).toMatchObject({ etat: "suspendu_gel", etape: "exporter" });
    // Clos et gelé malgré le gel pour litige ; l'équipe en est avertie ; seul l'export (retrait de données) attend la levée.
    expect(deposes).toEqual(["plan-1"]);
    expect(base.etat).toBe("gelee");
    expect(alertes.map((a) => a.code)).toEqual(["cloture_sous_gel", "base_gelee_sous_gel"]);
  });

  it("[A-255] @envoi une date de fin passée n'envoie pas trois préavis d'un coup", async () => {
    const envoyes: number[] = [];
    const alertes: AlerteFin[] = [];
    const dossier: Dossier = { ...dossierVide(), dateFin: "2026-09-01" };
    const preavis = ([1, 20, 27] as const).map((j) => etapePreavis(j, { envoyer: async () => void envoyes.push(j), marquer: async () => undefined, relancer: async () => undefined, gel: { gelActif: async () => false }, maintenant: () => new Date("2026-11-06T09:00:00Z") }));
    const machine = creerMachineFin({ etapes: preavis, dossier: async () => dossier, gel: { gelActif: async () => false }, alerter: async (a) => void alertes.push(a), maintenant: () => new Date("2026-11-06T09:00:00Z") });
    // Fin le 1er septembre, lancement le 6 novembre : J+1 et J+20 sont dépassés de plus de deux jours, aucun ne part ; une alerte chacun.
    expect(await machine.executer(T)).toMatchObject({ etat: "en_retard", etape: "preavis_j1" });
    expect(envoyes).toEqual([]);
    expect(alertes.map((a) => a.code)).toEqual(["preavis_j1_en_retard", "preavis_j20_en_retard", "preavis_j27_en_retard"]);
  });

  it("[A-254] une date de fin future ne gèle rien avant ce jour", async () => {
    const deposes: string[] = [];
    const base = { etat: "active" as LigneBase["etat"] };
    const gel = { gelActif: async () => false };
    const dossier: Dossier = { ...dossierVide(), dateFin: "2027-06-30" };
    let maintenant = new Date("2026-11-06T09:00:00Z");
    const machine = creerMachineFin({
      etapes: [
        etapeClore({ plans: async () => [{ idPlan: "plan-1", reponseRecue: false }], deposerClore: async (_t, id) => void deposes.push(id), alerter: async () => undefined, gel }),
        etapeGeler({ etatBase: async () => base.etat, geler: async () => { base.etat = "gelee"; }, pauserInstances: async () => undefined, instancesActives: async () => 1, emettreResilie: async () => undefined, alerter: async () => undefined, gel }),
      ],
      dossier: async () => dossier, gel, alerter: async () => undefined, maintenant: () => maintenant,
    });
    // Fin le 30 juin 2027 : le 6 novembre 2026, ni plan clos ni base gelée. La clôture attend minuit Europe/Paris (22 h UTC la veille, heure d'été).
    expect(await machine.executer(T)).toEqual({ etat: "attend_date", etape: "clore_plans", jusqua: new Date("2027-06-29T22:00:00.000Z") });
    expect(deposes).toEqual([]);
    expect(base.etat).toBe("active");
    maintenant = new Date("2027-06-29T22:00:00.000Z");
    await machine.executer(T);
    expect(deposes).toEqual(["plan-1"]);
  });

  it("[C-035] deux exécutions en même temps pour le même client ne se chevauchent pas (verrou par client)", async () => {
    const pris = new Set<string>();
    let lances = 0;
    const gel = { gelActif: async () => false };
    const dossier = dossierVide();
    const machine = creerMachineFin({
      etapes: [etapeExporter({ lancer: async () => { lances += 1; await new Promise((r) => setTimeout(r, 5)); return { reference: "exports/e1.zip", expireLe: new Date("2027-02-09T00:00:00Z") }; }, enregistrer: async (_t, ref) => { dossier.exportReference ??= ref; }, gel })],
      dossier: async () => dossier, gel, alerter: async () => undefined, maintenant: () => new Date("2027-01-10T08:00:00Z"),
      verrou: { prendre: async (t) => { if (pris.has(t)) return undefined; pris.add(t); return async () => void pris.delete(t); } },
    });
    const [a, b] = await Promise.all([machine.executer(T), machine.executer(T)]);
    expect([a.etat, b.etat].sort()).toEqual(["a_jour", "occupe"]);
    expect(lances).toBe(1);
  });

  it("[A-255] @envoi la tâche de chaque étape datée porte un jobId stable et valide pour BullMQ (ni deux-points, ni entier) et un délai calculé", () => {
    expect(idTacheFin(T, "preavis_j20")).toBe(`fin-${T}-preavis_j20`);
    const t = planifierTaches(T, "2027-01-10", new Date("2027-01-10T08:00:00Z"));
    expect(t.map((x) => x.jobId)).toEqual([`fin-${T}-clore_plans`, `fin-${T}-preavis_j1`, `fin-${T}-preavis_j20`, `fin-${T}-preavis_j27`]);
    // BullMQ refuse « : » dans un identifiant personnalisé et tout identifiant qui est un entier.
    for (const x of t) { expect(x.jobId).not.toContain(":"); expect(Number.isInteger(Number(x.jobId))).toBe(false); }
    // La clôture n'est plus planifiée tout de suite : elle l'est à minuit Europe/Paris de la date de fin.
    expect(t[0]?.delaiMs).toBe(0);
    expect(planifierTaches(T, "2027-06-30", new Date("2026-11-06T09:00:00Z"))[0]?.delaiMs).toBe(Date.parse("2027-06-29T22:00:00Z") - Date.parse("2026-11-06T09:00:00Z"));
    expect(t[1]?.delaiMs).toBe(echeance("2027-01-10", 1).getTime() - Date.parse("2027-01-10T08:00:00Z"));
    expect(() => idTacheFin("pas-un-uuid", "preavis_j1")).toThrow();
  });

  it("[C-715] aucune étape ne contient d'accès à l'effacement ni de suppression, et machine.ts s'arrête à l'attente de mise à l'écart", () => {
    const dossier = fileURLToPath(new URL(".", import.meta.url));
    const sources = readdirSync(dossier).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    expect(sources.length).toBeGreaterThanOrEqual(5);
    for (const f of sources) {
      const code = readFileSync(dossier + f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
      expect(code, f).not.toMatch(/effacer|\bDELETE\b|\bDROP\b|TRUNCATE|detruireCleClient|unlink|rmSync|deleteObject/i);
    }
    expect(ETAPES.at(-1)).toBe("attente_mise_a_l_ecart");
  });

  it("[A-253] une demande écrite d'effacement crée une demande en attente, alerte Will et ne change aucune date", async () => {
    const dossier = dossierVide();
    const avant = JSON.stringify(dossier);
    const demandes: unknown[] = [];
    const alertes: unknown[] = [];
    const r = await recevoirDemandeEffacement({ creer: async (t, ref) => { demandes.push({ t, ref }); return { id: "d1" }; }, alerter: async (a) => void alertes.push(a) }, T, "objet/ecrit-du-client-1");
    expect(r).toEqual({ id: "d1" });
    expect(demandes).toEqual([{ t: T, ref: "objet/ecrit-du-client-1" }]);
    expect(alertes).toEqual([{ type: "demande_effacement", clientId: T, code: "decision_de_will_attendue" }]);
    expect(JSON.stringify(dossier)).toBe(avant);
    expect(echeance(DATE_FIN, 27).toISOString()).toBe("2027-02-05T23:00:00.000Z");
    await expect(recevoirDemandeEffacement({ creer: async () => ({ id: "x" }), alerter: async () => undefined }, T, "  ")).rejects.toBeInstanceOf(ErreurApi);
  });
});
