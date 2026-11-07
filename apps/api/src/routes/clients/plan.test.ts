import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { lirePlanClient } from "../../commercial/plan-client.ts";
import { assemblerNiveaux, type Entrees } from "../../commercial/lire-niveaux.ts";
import { calculerPlan, type PlanPrepare } from "../../commercial/plan.ts";
import type { Requeteur } from "../../instances/activer.ts";
import { brancherErreurs } from "../../plugins/erreurs.js";
import { routePlan, type DepsPlan } from "./plan.js";

// Onglet Contrat et plan (T3-14a) : lecture du plan ENREGISTRÉ, jamais recalculé. Montants FICTIFS en centimes, identifiants tirés au hasard, aucun vrai client.
const A = randomUUID();
const B = randomUUID();
const JOUR = "2026-11-07";
type Ligne = Record<string, unknown>;

const COLONNES_SOURCE = { formule: "source_formule", fraisMiseEnPlace: "source_frais_mise_en_place", prixRecurrentMensuel: "source_prix_recurrent_mensuel", periodeFacturation: "source_periode_facturation", modeAvance: "source_mode_avance", maintenanceIncluse: "source_maintenance_incluse", suiteMaintenance: "source_suite_maintenance", engagement: "source_engagement" } as const;
// La ligne que la base rendrait : bigint en TEXTE comme pg, sources telles qu'enregistrées.
function ligneDe(p: PlanPrepare, surcharge: Ligne = {}): Ligne {
  const l: Ligne = {
    instance_id: randomUUID(), code_automatisation: "relance-devis", etat: "active", formule: p.formule, plan_id: randomUUID(), plan_auteur: "agent-essai", enregistre_le: "2026-11-02T08:30:00.000Z",
    frais_mise_en_place_ht_centimes: String(p.fraisMiseEnPlaceHtCentimes), prix_recurrent_mensuel_ht_centimes: String(p.prixRecurrentMensuelHtCentimes),
    periode_facturation_mois: p.periodeFacturationMois, mode_avance: p.modeAvance, maintenance_incluse_mois: p.maintenanceIncluseMois, suite_maintenance: p.suiteMaintenance, engagement_mois: p.engagementMois,
  };
  for (const [cle, colonne] of Object.entries(COLONNES_SOURCE)) l[colonne] = p.sources[cle as keyof typeof COLONNES_SOURCE];
  return { ...l, ...surcharge };
}
const GRILLE = (frais: number, mensuel: number) => ({ fraisMiseEnPlaceCentimes: frais, tarifMensuelCentimes: mensuel, maintenanceIncluseMois: 3, formulesActives: ["abonnement", "achat", "installation_maintenance"] });
const DEFAUTS = [{ type: "engagement", valeur: { engagement_mois: 12, suite_maintenance: "arret" } }, { type: "periode", valeur: { periode_facturation_mois: 1, mode_avance: "aucune" } }];
const calculer = (frais: number, mensuel: number, client: Entrees["client"] = [], instance: Entrees["instance"] = {}): PlanPrepare => {
  const e: Entrees = { grille: GRILLE(frais, mensuel), defauts: DEFAUTS, metier: null, client, instance };
  return calculerPlan(assemblerNiveaux(e), "abonnement", e.grille?.formulesActives ?? null);
};

function fauxClient(lignes: Ligne[], phases: Ligne[] = [], conditions: Ligne[] = []) {
  const appels: string[] = [];
  const client: Requeteur = {
    async query(texte) {
      appels.push(texte);
      const rows = texte.includes("FROM instances") ? lignes : texte.includes("FROM phases_plan") ? phases : texte.includes("FROM conditions_commerciales") ? conditions : [];
      return { rows, rowCount: rows.length };
    },
  };
  return { client, appels };
}
function serveur(c: Requeteur, o: { ouvert?: boolean; voit?: string[] } = {}) {
  const lectures: string[] = [];
  const app = Fastify();
  brancherErreurs(app);
  const deps: DepsPlan = {
    ouvert: () => o.ouvert ?? true,
    exigerEquipe: (async () => undefined) as never,
    session: async () => ({ acteur: "agent-essai", peutVoir: (id: string) => (o.voit ?? [A]).includes(id) }),
    async lire(id, jour) { lectures.push(id); return lirePlanClient(c, id, jour); },
  };
  routePlan(app, deps);
  return { app, lectures };
}
const url = (id: string) => `/api/console/v1/clients/${id}/plan`;
const phase = (plan_id: unknown, ordre: number, debut: string, fin: string | null): Ligne => ({ plan_id, ordre, nature: ordre === 1 ? "mise_en_place" : "recurrente", debut, fin, montant_ht_centimes: "12345", periode_facturation_mois: 1 });
const condition = (valeur: Ligne = { frais_mise_en_place_centimes: 4000 }): Ligne => ({ id: randomUUID(), type: "frais", valeur, valide_du: "2026-01-01", valide_au: null, auteur: "agent-essai", modifie_le: "2026-10-30T09:00:00.000Z" });
const CLES_VALEURS = ["engagement_mois", "formule", "frais_mise_en_place_ht_centimes", "maintenance_incluse_mois", "mode_avance", "periode_facturation_mois", "prix_recurrent_mensuel_ht_centimes", "suite_maintenance"];

describe("route du plan d'un client", () => {
  it("[B-037] l'onglet montre phases et conditions du plan calculé", async () => {
    const ligne = ligneDe(calculer(5000, 1000));
    const { client } = fauxClient([ligne], [phase(ligne["plan_id"], 1, "2026-11-01", "2026-11-30"), phase(ligne["plan_id"], 2, "2026-12-01", null)], [condition()]);
    const rep = await serveur(client).app.inject({ method: "GET", url: url(A) });
    expect(rep.statusCode).toBe(200);
    const corps = rep.json();
    expect(Object.keys(corps).sort()).toEqual(["acompte", "conditions", "plans"]);
    expect(corps.acompte).toBeNull();
    expect(Object.keys(corps.plans[0]).sort()).toEqual(["automatisation", "etat", "instance_id", "plan"]);
    expect(Object.keys(corps.plans[0].plan).sort()).toEqual(["auteur", "enregistre_le", "id", "phases", "valeurs"]);
    expect(Object.keys(corps.plans[0].plan.valeurs).sort()).toEqual(CLES_VALEURS);
    expect(corps.plans[0].plan.phases.map((p: Ligne) => Object.keys(p).sort())).toEqual([["debut", "fin", "montant_ht_centimes", "nature", "ordre", "periode_facturation_mois", "statut"], ["debut", "fin", "montant_ht_centimes", "nature", "ordre", "periode_facturation_mois", "statut"]]);
    expect(Object.keys(corps.conditions[0]).sort()).toEqual(["auteur", "id", "modifie_le", "personnalise", "type", "valeur", "valide_au", "valide_du"].sort());
    expect(JSON.stringify(corps)).not.toMatch(/plan_id|tenant_id|plan_auteur|source_/);
  });

  it("[C-139] chaque valeur du plan dit d'où elle vient", async () => {
    const { client } = fauxClient([ligneDe(calculer(5000, 1000, [{ type: "frais", valeur: { tarif_mensuel_centimes: 900 } }]))]);
    const corps = (await serveur(client).app.inject({ method: "GET", url: url(A) })).json();
    const valeurs = corps.plans[0].plan.valeurs as Record<string, { valeur: unknown; source: string }>;
    for (const cle of CLES_VALEURS) expect(["catalogue", "defaut", "client", "instance"], cle).toContain(valeurs[cle]?.source);
    expect(valeurs["frais_mise_en_place_ht_centimes"]?.source).toBe("catalogue");
    expect(valeurs["prix_recurrent_mensuel_ht_centimes"]?.source).toBe("client");
    expect(valeurs["formule"]?.source).toBe("instance");
    expect(JSON.stringify(corps)).not.toContain("grille");
  });

  it("[C-183] une condition propre au client porte le repère « personnalisé »", async () => {
    const avecClient = fauxClient([ligneDe(calculer(5000, 1000, [{ type: "engagement", valeur: { engagement_mois: 6 } }]))], [], [condition()]);
    const c = (await serveur(avecClient.client).app.inject({ method: "GET", url: url(A) })).json();
    expect(c.plans[0].plan.valeurs.engagement_mois).toEqual({ valeur: 6, source: "client" });
    expect(c.plans[0].plan.valeurs.engagement_mois.personnalise).toBe(true);
    expect(c.conditions[0].personnalise).toBe(true);
    // Source « instance » : choisie pour cette automatisation, pas personnalisée.
    const instance = (await serveur(fauxClient([ligneDe(calculer(5000, 1000))]).client).app.inject({ method: "GET", url: url(A) })).json();
    expect(instance.plans[0].plan.valeurs.formule.source).toBe("instance");
    expect(instance.plans[0].plan.valeurs.formule.personnalise).toBe(false);
    expect(instance.plans[0].plan.valeurs.engagement_mois.personnalise).toBe(false);
  });

  it("[A-161] une instance sans plan enregistré rend plan null, sans aucun calcul", async () => {
    const { client, appels } = fauxClient([{ instance_id: randomUUID(), code_automatisation: "relance-devis", etat: "active", formule: "abonnement", plan_id: null }]);
    const corps = (await serveur(client).app.inject({ method: "GET", url: url(A) })).json();
    expect(corps.plans).toHaveLength(1);
    expect(corps.plans[0].plan).toBeNull();
    expect(appels.some((t) => t.includes("FROM phases_plan"))).toBe(false);
    for (const f of ["../../commercial/plan-client.ts", "./plan.ts"]) {
      const source = readFileSync(new URL(f, import.meta.url), "utf8");
      expect(source, f).not.toMatch(/commercial\/plan\.(ts|js)|from "\.\/plan\.(ts|js)"|calculerPlan|preparerPlan/);
    }
  });

  it("[LOT3-argent] @argent 10 plans fictifs : montants rendus = montants calculés par calculerPlan", async () => {
    const jeux: [number, number][] = [[0, 0], [1, 99], [99, 101], [101, 1], [5001, 1999], [12345, 67891], [100000, 3], [7, 9007199254740991], [9007199254740991, 0], [250, 499]];
    expect(jeux).toHaveLength(10);
    for (const [frais, mensuel] of jeux) {
      const calcule = calculer(frais, mensuel);
      const { client } = fauxClient([ligneDe(calcule)]);
      const valeurs = (await serveur(client).app.inject({ method: "GET", url: url(A) })).json().plans[0].plan.valeurs;
      expect(valeurs.frais_mise_en_place_ht_centimes.valeur).toBe(calcule.fraisMiseEnPlaceHtCentimes);
      expect(valeurs.prix_recurrent_mensuel_ht_centimes.valeur).toBe(calcule.prixRecurrentMensuelHtCentimes);
      expect(typeof valeurs.frais_mise_en_place_ht_centimes.valeur).toBe("number");
    }
  });

  it("[LOT3-argent] @argent un montant hors entier sûr venu de la base rend 500 sans réponse partielle", async () => {
    for (const mauvais of ["9007199254740992", "-1", "12.5", "1e3", "abc", ""]) {
      const { client } = fauxClient([ligneDe(calculer(5000, 1000), { prix_recurrent_mensuel_ht_centimes: mauvais })]);
      const rep = await serveur(client).app.inject({ method: "GET", url: url(A) });
      expect(rep.statusCode, mauvais).toBe(500);
      expect(rep.json()).toEqual({ erreur: { code: "erreur_interne", message: "Erreur interne.", id_trace: expect.any(String) } });
    }
    const ligne = ligneDe(calculer(5000, 1000));
    const { client } = fauxClient([ligne], [{ ...phase(ligne["plan_id"], 1, "2026-11-01", null), montant_ht_centimes: "12.5" }]);
    expect((await serveur(client).app.inject({ method: "GET", url: url(A) })).statusCode).toBe(500);
  });

  it("[LOT3-argent] la porte fermée rend 503 sans lecture", async () => {
    const { client, appels } = fauxClient([]);
    const { app, lectures } = serveur(client, { ouvert: false });
    expect((await app.inject({ method: "GET", url: url(A) })).statusCode).toBe(503);
    expect(lectures).toEqual([]);
    expect(appels).toEqual([]);
  });

  it("[LOT3-argent] un client hors portée rend 404 sans lecture", async () => {
    const { client, appels } = fauxClient([]);
    const { app, lectures } = serveur(client, { voit: [A] });
    const rep = await app.inject({ method: "GET", url: url(B) });
    expect(rep.statusCode).toBe(404);
    expect(rep.json().erreur.code).toBe("introuvable");
    expect(lectures).toEqual([]);
    expect(appels).toEqual([]);
    expect((await app.inject({ method: "GET", url: url("pas-un-uuid") })).statusCode).toBe(400);
  });
});
