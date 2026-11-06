import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ErreurApi } from "../plugins/erreurs.js";
import { GelPourLitige } from "../gel/garde.js";
import { ETAPES, ajouterJours, creerMachineFin, echeance, idTacheFin, planifierTaches, recevoirDemandeEffacement, type Dossier, type EtapeFin } from "./machine.js";

const T = "11111111-1111-4111-8111-111111111111";
const DATE_FIN = "2027-01-10";
const dossierVide = (): Dossier => ({ dateFin: DATE_FIN, exportReference: null, exportTelechargeLe: null, preavis: { 1: { envoyeLe: null, accuse: null }, 20: { envoyeLe: null, accuse: null }, 27: { envoyeLe: null, accuse: null } } });

// Étapes factices : chacune note son passage et peut rester « pas finie » (réponses du Hub non reçues).
function monter(o: { gel?: () => boolean; reponsesRecues?: () => boolean } = {}) {
  const faits = new Set<string>();
  const appels: string[] = [];
  let maintenant = new Date("2027-01-10T08:00:00Z");
  const etape = (nom: string, jours?: number): EtapeFin => ({
    nom,
    echeance: jours === undefined ? undefined : () => echeance(DATE_FIN, jours),
    dejaFait: async () => faits.has(nom),
    faire: async () => { appels.push(nom); if (nom !== "clore_plans" || (o.reponsesRecues?.() ?? true)) faits.add(nom); },
  });
  const machine = creerMachineFin({
    etapes: [etape("clore_plans"), etape("geler_base"), etape("exporter"), etape("preavis_j1", 1), etape("preavis_j20", 20), etape("preavis_j27", 27)],
    dossier: async () => dossierVide(),
    gel: { gelActif: async () => o.gel?.() ?? false },
    maintenant: () => maintenant,
  });
  return { machine, appels, avancer: (iso: string) => { maintenant = new Date(iso); } };
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
    m.avancer("2027-01-30T23:00:00Z");
    m.avancer("2027-02-06T23:00:00Z");
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

  it("[C-609] pendant un gel, aucune étape ne démarre ; la reprise a lieu après la levée", async () => {
    let gel = true;
    const m = monter({ gel: () => gel });
    expect(await m.machine.executer(T)).toMatchObject({ etat: "suspendu_gel" });
    expect(m.appels).toEqual([]);
    gel = false;
    await m.machine.executer(T);
    expect(m.appels).toContain("geler_base");
    expect(new GelPourLitige("preavis").motif).toBe("gel_pour_litige");
  });

  it("[A-255] @envoi la tâche de chaque étape datée porte un jobId stable fin:<client>:<étape> et un délai calculé", () => {
    expect(idTacheFin(T, "preavis_j20")).toBe(`fin:${T}:preavis_j20`);
    const t = planifierTaches(T, "2027-01-10", new Date("2027-01-10T08:00:00Z"));
    expect(t.map((x) => x.jobId)).toEqual([`fin:${T}:clore_plans`, `fin:${T}:preavis_j1`, `fin:${T}:preavis_j20`, `fin:${T}:preavis_j27`]);
    expect(t[0]?.delaiMs).toBe(0);
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
    expect(echeance(DATE_FIN, 27).toISOString()).toBe("2027-02-06T23:00:00.000Z");
    await expect(recevoirDemandeEffacement({ creer: async () => ({ id: "x" }), alerter: async () => undefined }, T, "  ")).rejects.toBeInstanceOf(ErreurApi);
  });
});
