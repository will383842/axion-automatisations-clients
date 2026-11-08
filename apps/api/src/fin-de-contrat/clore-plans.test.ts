import { describe, expect, it } from "vitest";
import { clientC1 } from "../hub/client-c1.js";
import { traiterReponse, type AlerteHub } from "../hub/reponses.js";
import { etapeClore, type PlanHub } from "./clore-plans.js";
import { creerMachineFin, type Dossier, type EtapeFin } from "./machine.js";

const T = "11111111-1111-4111-8111-111111111111";
const D: Dossier = { dateFin: "2027-01-10", exportReference: null, exportTelechargeLe: null, preavis: { 1: { envoyeLe: null, accuse: null }, 20: { envoyeLe: null, accuse: null }, 27: { envoyeLe: null, accuse: null } } };

function monter(plans: PlanHub[], gel = false) {
  const deposes: string[] = [];
  const alertes: { code: string }[] = [];
  const etape = etapeClore({ plans: async () => plans, deposerClore: async (_t, idPlan, dateFin) => void deposes.push(`${idPlan}:${dateFin}`), alerter: async (a) => void alertes.push(a), gel: { gelActif: async () => gel } });
  return { etape, deposes, alertes };
}

describe("clôture des plans du Hub", () => {
  it("[A-250] @argent avant tout, les plans récurrents du client sont clos dans le Hub par la porte signée ; l'étape suivante attend toutes les réponses", async () => {
    const m = monter([{ idPlan: "plan-1", reponseRecue: true }, { idPlan: "plan-2", reponseRecue: false }, { idPlan: "plan-3", reponseRecue: false }]);
    expect(await m.etape.dejaFait(T, D)).toBe(false);
    await m.etape.faire(T, D);
    // Seuls les plans sans réponse sont (re)déposés, avec la date de fin du contrat ; le plan déjà clos n'est pas redéposé.
    expect(m.deposes).toEqual(["plan-2:2027-01-10", "plan-3:2027-01-10"]);
    const toutes = monter([{ idPlan: "plan-1", reponseRecue: true }, { idPlan: "plan-2", reponseRecue: true }]);
    expect(await toutes.etape.dejaFait(T, D)).toBe(true);
    // Hub coupé : une seule réponse manque, l'étape n'est pas faite.
    expect(await monter([{ idPlan: "plan-1", reponseRecue: true }, { idPlan: "plan-2", reponseRecue: false }]).etape.dejaFait(T, D)).toBe(false);
  });

  it("[A-250] @argent un plan déposé mais non lié (réponse de création perdue) bloque l'étape et alerte, sans rien clore au hasard", async () => {
    const m = monter([{ idPlan: null, reponseRecue: false }, { idPlan: "plan-1", reponseRecue: false }]);
    await m.etape.faire(T, D);
    expect(m.alertes).toEqual([{ type: "clore_plans", clientId: T, code: "plan_non_lie" }]);
    expect(await m.etape.dejaFait(T, D)).toBe(false);
    expect(m.deposes).toEqual(["plan-1:2027-01-10"]);
  });

  it("[C-609] @argent pendant un gel la clôture continue (rien n'est détruit) et l'équipe est avertie", async () => {
    const m = monter([{ idPlan: "plan-1", reponseRecue: false }], true);
    await m.etape.faire(T, D);
    expect(m.deposes).toEqual(["plan-1:2027-01-10"]);
    expect(m.alertes).toEqual([{ type: "clore_plans", clientId: T, code: "cloture_sous_gel" }]);
    expect(m.etape.sousGel).toBe(false);
  });

  it("[A-250] un brouillon non émis signalé par le Hub déclenche une alerte et n'est jamais supprimé", async () => {
    const requetes: string[] = [];
    const alertes: AlerteHub[] = [];
    const tx = { query: async (texte: string) => { requetes.push(texte); return { rows: [] }; } };
    const r = await traiterReponse(tx, T, { route: "plans-recurrents-clore", statut: 200, corps: { idPlan: "plan-1", brouillonsNonEmis: ["b1", "b2"] } }, async (a) => void alertes.push(a));
    expect(r).toEqual({ rangee: "alerte" });
    expect(alertes).toEqual([{ niveau: "critique", code: "clore_brouillons_non_emis", idPlan: "plan-1", nombre: 2 }]);
    expect(requetes.join(" ")).not.toMatch(/DELETE|TRUNCATE|DROP/i);
    // La porte signée ne sait pas supprimer : aucune méthode de suppression dans le client C1.
    expect(Object.keys(clientC1({ deposer: async () => ({ nouveau: true }), tx })).join(" ")).not.toMatch(/suppr|supprim|delete|effac/i);
  });
});

describe("clôture en échec définitif (T2-44b-b)", () => {
  it("[A-250] @argent une clôture en échec définitif lève l'alerte cloture_en_echec et l'étape suivante ne démarre jamais", async () => {
    const m = monter([{ idPlan: "plan-1", reponseRecue: false, enEchec: true }]);
    await m.etape.faire(T, D);
    expect(m.alertes).toEqual([{ type: "clore_plans", clientId: T, code: "cloture_en_echec" }]);
    // dejaFait reste inchangé : un plan en échec n'est jamais compté clos.
    expect(await m.etape.dejaFait(T, D)).toBe(false);
    const suivante = { faites: 0 };
    const geler: EtapeFin = { nom: "geler_base", sousGel: false, echeance: () => new Date(0), dejaFait: async () => false, faire: async () => void suivante.faites++ };
    const machine = creerMachineFin({ etapes: [m.etape, geler], dossier: async () => D, gel: { gelActif: async () => false }, alerter: async () => undefined, maintenant: () => new Date("2027-02-01T00:00:00Z") });
    expect(await machine.executer(T)).toMatchObject({ etat: "attend_reponses", etape: "clore_plans" });
    expect(suivante.faites).toBe(0);
  });
});
