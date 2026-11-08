import { describe, expect, it } from "vitest";
import { cleDIntention } from "../../../../packages/contrats/src/commun/idempotence.js";
import { creerExpediteur, magasinEnMemoire } from "../canaux/expediteur.js";
import { alerterEnBase, dossierEnBase, enregistrerAccuseEnBase, enregistrerExportEnBase, gelEnBase, lancerEnBase, marquerPreavisEnBase, planDepuisLignes, plansEnBase, type Avec, type Requeteur } from "./adaptateurs-pg.js";
import { etapeClore } from "./clore-plans.js";
import { creerMachineFin, planifierTaches, REESSAI_REPONSES_MS, type Dossier } from "./machine.js";
import { deposerTachesFin } from "./ordonnanceur.js";

const T = "11111111-1111-4111-8111-111111111111";
const D: Dossier = { dateFin: "2027-03-31", exportReference: null, exportTelechargeLe: null, preavis: { 1: { envoyeLe: null, accuse: null }, 20: { envoyeLe: null, accuse: null }, 27: { envoyeLe: null, accuse: null } } };
const maintenant = () => new Date("2027-03-01T10:00:00Z");
const cleClore = (idPlan: string) => cleDIntention("hub", JSON.stringify([T, `clore:${idPlan}`]));

// Fausse base qui reproduit INSERT … ON CONFLICT (tenant_id) DO NOTHING ; chaque requête est gardée avec le client de la transaction.
function fausseBase(initial: Record<string, string> = {}) {
  const fins = new Map<string, string>(Object.entries(initial));
  const requetes: { sql: string; valeurs: unknown[] }[] = [];
  const tenants: string[] = [];
  const evenements: string[] = [];
  const avec: Avec = async (tenantId, fn) => {
    tenants.push(tenantId);
    const c: Requeteur = {
      query: async (sql, valeurs = []) => {
        requetes.push({ sql, valeurs });
        await Promise.resolve();
        if (/^INSERT INTO fins_de_contrat/.test(sql)) {
          const [t, d] = valeurs as [string, string];
          if (fins.has(t)) return { rows: [] };
          fins.set(t, d);
          return { rows: [{ id: "ligne" }] };
        }
        if (/^SELECT date_fin::text AS d/.test(sql)) return { rows: [{ d: fins.get(valeurs[0] as string) }] };
        return { rows: [], rowCount: 0 };
      },
    };
    const r = await fn(c);
    evenements.push("valide");
    return r;
  };
  return { avec, fins, requetes, tenants, evenements };
}
function fausseFile() {
  const jobs = new Map<string, { etat: string }>();
  return {
    ids: () => [...jobs.keys()],
    getJob: async (id: string) => (jobs.has(id) ? { getState: async () => jobs.get(id)!.etat, remove: async () => void jobs.delete(id) } : undefined),
    add: async (_nom: string, _donnees: unknown, options: Record<string, unknown>) => { if (!jobs.has(options["jobId"] as string)) jobs.set(options["jobId"] as string, { etat: "delayed" }); },
  };
}

describe("adaptateurs SQL de la fin de contrat", () => {
  it("[C-035] deux lancements simultanés : une ligne, une planification (lancee puis deja_lancee ; planifier appelé une fois ; quatre jobId fin-<t>-<étape>)", async () => {
    const base = fausseBase();
    const file = fausseFile();
    let appels = 0;
    const lancer = lancerEnBase({ avec: base.avec, maintenant, planifier: async (t, d) => { appels++; base.evenements.push("planifie"); await deposerTachesFin(file, t, d, maintenant); } });
    const demande = { tenantId: T, dateFin: "2027-03-31", acteur: "agent-essai" };
    const resultats = await Promise.all([lancer(demande), lancer(demande)]);
    expect([...resultats].sort()).toEqual(["deja_lancee", "lancee"]);
    expect(base.fins.size).toBe(1);
    expect(appels).toBe(1);
    expect(file.ids().sort()).toEqual(planifierTaches(T, "2027-03-31", maintenant()).map((x) => x.jobId).sort());
    expect(file.ids()).toHaveLength(4);
    // Planification APRÈS validation de la transaction du gagnant.
    expect(base.evenements.indexOf("planifie")).toBeGreaterThan(base.evenements.indexOf("valide"));
  });

  it("[C-035] un lancement avec une autre date rend autre_date : rien n'est modifié ni planifié", async () => {
    const base = fausseBase({ [T]: "2027-03-31" });
    let appels = 0;
    const lancer = lancerEnBase({ avec: base.avec, maintenant, planifier: async () => void appels++ });
    expect(await lancer({ tenantId: T, dateFin: "2027-04-30", acteur: "agent-essai" })).toBe("autre_date");
    expect(await lancer({ tenantId: T, dateFin: "2027-03-31", acteur: "agent-essai" })).toBe("deja_lancee");
    expect(base.fins.get(T)).toBe("2027-03-31");
    expect(appels).toBe(0);
    expect(base.requetes.some((r) => /^(UPDATE|DELETE)/.test(r.sql))).toBe(false);
  });

  it("[A-250] @argent reponseRecue n'est vrai que pour une ligne de clôture « envoye » : a_envoyer, en_cours et echec restent faux", () => {
    const phases = [{ id: "ph-1", idPlanHub: "plan-1" }];
    for (const etat of ["a_envoyer", "en_cours", "echec"]) expect(planDepuisLignes(T, phases, [{ cle: cleClore("plan-1"), etat }])[0]).toMatchObject({ idPlan: "plan-1", reponseRecue: false });
    expect(planDepuisLignes(T, phases, [{ cle: cleClore("plan-1"), etat: "envoye" }])).toEqual([{ idPlan: "plan-1", reponseRecue: true, enEchec: false }]);
    expect(planDepuisLignes(T, phases, [])).toEqual([{ idPlan: "plan-1", reponseRecue: false, enEchec: false }]);
    expect(planDepuisLignes(T, phases, [{ cle: cleClore("plan-1"), etat: "echec" }])[0]?.enEchec).toBe(true);
    // La clé d'un autre plan ne ferme pas celui-ci ; deux phases d'un même plan ne font qu'un plan.
    expect(planDepuisLignes(T, phases, [{ cle: cleClore("plan-2"), etat: "envoye" }])[0]?.reponseRecue).toBe(false);
    expect(planDepuisLignes(T, [...phases, { id: "ph-2", idPlanHub: "plan-1" }], [])).toHaveLength(1);
  });

  it("[A-250] @argent une phase déposée mais jamais liée (id_plan_hub nul) est rendue avec idPlan null ; une phase jamais déposée est ignorée", () => {
    const phases = [{ id: "ph-9", idPlanHub: null }, { id: "ph-8", idPlanHub: null }];
    const deposee = { cle: cleDIntention("hub", JSON.stringify([T, "plan:ph-9"])), etat: "envoye" };
    expect(planDepuisLignes(T, phases, [deposee])).toEqual([{ idPlan: null, reponseRecue: false, enEchec: false }]);
    expect(planDepuisLignes(T, phases, [])).toEqual([]);
  });

  it("[A-250] @argent un Hub qui répond 503 laisse la ligne à envoyer et le plan n'est pas compté clos", async () => {
    const magasin = magasinEnMemoire();
    const ref = magasin.deposer({ tenantId: T, destination: "hub", route: "/api/console/v1/plans-recurrents/plan-1/clore", methode: "POST", corps: { dateFin: "2027-03-31", motif: "fin_de_contrat" }, cle: cleClore("plan-1") });
    const expediteur = creerExpediteur({ magasin, signeur: { signerRequete: async () => ({}) }, urls: { hub: "https://hub.exemple.test", crm: "https://crm.exemple.test" }, alerter: () => undefined, fetch: (async () => new Response("{}", { status: 503 })) as typeof fetch });
    expect(await expediteur.executer(ref)).toBe("reessai");
    expect(magasin.lignes()[0]?.etat).toBe("a_envoyer");
    const gel = { gelActif: async () => false };
    const etape = etapeClore({ plans: async () => planDepuisLignes(T, [{ id: "ph-1", idPlanHub: "plan-1" }], magasin.lignes().map((l) => ({ cle: l.cle, etat: l.etat }))), deposerClore: async () => undefined, alerter: async () => undefined, gel });
    expect(await etape.dejaFait(T, D)).toBe(false);
    const machine = creerMachineFin({ etapes: [etape], dossier: async () => D, gel, alerter: async () => undefined, maintenant: () => new Date("2027-04-01T00:00:00Z") });
    expect(await machine.executer(T)).toMatchObject({ etat: "attend_reponses", reessayerDansMs: REESSAI_REPONSES_MS });
  });

  it("[A-255] @envoi marquer un préavis : la première date gagne, et la colonne vient d'une liste fermée (jamais interpolée depuis l'appel)", async () => {
    const base = fausseBase();
    const marquer = marquerPreavisEnBase(base.avec);
    for (const [jour, colonne] of [[1, "preavis_j1_envoye_le"], [20, "preavis_j20_envoye_le"], [27, "preavis_j27_envoye_le"]] as const) {
      await marquer(T, jour, maintenant());
      const r = base.requetes.at(-1)!;
      expect(r.sql).toBe(`UPDATE fins_de_contrat SET ${colonne} = $2 WHERE tenant_id = $1 AND ${colonne} IS NULL`);
      expect(r.valeurs).toEqual([T, maintenant()]);
    }
    const avant = base.requetes.length;
    await expect(marquer(T, "1; DROP TABLE fins_de_contrat" as never, maintenant())).rejects.toThrow();
    await expect(marquer(T, 2 as never, maintenant())).rejects.toThrow();
    expect(base.requetes).toHaveLength(avant);
    // L'accusé suit la même règle : seulement si le préavis est envoyé et sans accusé encore.
    await enregistrerAccuseEnBase(base.avec)(T, 20, "recu:2027-04-02T00:00:00.000Z");
    expect(base.requetes.at(-1)!.sql).toBe("UPDATE fins_de_contrat SET preavis_j20_accuse = $2 WHERE tenant_id = $1 AND preavis_j20_envoye_le IS NOT NULL AND preavis_j20_accuse IS NULL RETURNING 1 AS ok");
  });

  it("[C-035] l'export enregistré : la première référence gagne (UPDATE … WHERE export_reference IS NULL)", async () => {
    const base = fausseBase();
    await enregistrerExportEnBase(base.avec)(T, "export-essai-1", new Date("2027-04-30T00:00:00Z"));
    const r = base.requetes.at(-1)!;
    expect(r.sql).toBe("UPDATE fins_de_contrat SET export_reference = $2, export_expire_le = $3 WHERE tenant_id = $1 AND export_reference IS NULL");
    expect(r.valeurs[0]).toBe(T);
    expect(base.requetes.some((q) => /DELETE|DROP|TRUNCATE/i.test(q.sql))).toBe(false);
  });

  it("[C-035] l'alerte de la fin de contrat a la clé stable <type>:<code>, s'insère par ON CONFLICT sur alertes_une_ouverte_par_cle et ne porte que des codes", async () => {
    const base = fausseBase();
    const alerter = alerterEnBase(base.avec);
    await alerter({ type: "fin_de_contrat", clientId: T, code: "preavis_j1_en_retard" });
    const r = base.requetes.at(-1)!;
    expect(r.sql).toContain("ON CONFLICT (tenant_id, cle_regroupement) WHERE cle_regroupement IS NOT NULL AND etat IN ('ouverte', 'acquittee') DO NOTHING");
    expect(r.valeurs).toContain("fin_de_contrat:preavis_j1_en_retard");
    const avant = base.requetes.length;
    await expect(alerter({ type: "fin_de_contrat", clientId: T, code: "Texte libre avec espaces" })).rejects.toThrow();
    await expect(alerter({ type: "Type Libre", clientId: T, code: "ok" })).rejects.toThrow();
    expect(base.requetes).toHaveLength(avant);
  });

  it("[C-035] @isolation chaque requête des adaptateurs filtre tenant_id = $1 dans avecClient du client de la tâche ; un tenantId hors forme est refusé", async () => {
    const base = fausseBase();
    await dossierEnBase(base.avec)(T);
    await plansEnBase(base.avec)(T);
    await marquerPreavisEnBase(base.avec)(T, 1, maintenant());
    await enregistrerAccuseEnBase(base.avec)(T, 1, "recu:x");
    await enregistrerExportEnBase(base.avec)(T, "ref", maintenant());
    await alerterEnBase(base.avec)({ type: "fin_de_contrat", clientId: T, code: "ok" });
    await lancerEnBase({ avec: base.avec, maintenant, planifier: async () => undefined })({ tenantId: T, dateFin: "2027-03-31", acteur: "agent-essai" });
    expect(base.requetes.length).toBeGreaterThan(6);
    for (const r of base.requetes) expect(r.sql, r.sql).toMatch(/tenant_id = \$1|\(tenant_id[^)]*\) VALUES \(\$1,/);
    expect(new Set(base.tenants)).toEqual(new Set([T]));
    const avant = base.requetes.length;
    await expect(plansEnBase(base.avec)("pas-un-uuid")).rejects.toThrow();
    await expect(dossierEnBase(base.avec)(`${T}' OR '1'='1`)).rejects.toThrow();
    expect(base.requetes).toHaveLength(avant);
  });

  it("[A-255] @envoi le port gel des adaptateurs relaie gelActif du gel réel", async () => {
    const vus: string[] = [];
    const gel = gelEnBase({ gelActif: async (t) => { vus.push(t); return true; } });
    expect(await gel.gelActif(T)).toBe(true);
    expect(vus).toEqual([T]);
  });
});
