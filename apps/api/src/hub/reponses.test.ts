import { describe, expect, it } from "vitest";
import { traiterReponse } from "./reponses.ts";

const TENANT = "11111111-1111-4111-8111-111111111111";
const PHASE = "33333333-3333-4333-8333-333333333333";
// Faux accès : applique le « WHERE NOT EXISTS » de a_trancher (clé = dernier paramètre) et simule phases_plan (lié = id déjà posé).
function banc(opts: { phaseLiee?: string | null; phaseAbsente?: boolean } = {}) {
  const requetes: { texte: string; valeurs: unknown[] }[] = [];
  const cles = new Set<string>();
  const etats = new Map<string, string>();
  const inserees: string[] = [];
  const alertes: { niveau: string; code: string }[] = [];
  const tx = {
    query: async (texte: string, valeurs: unknown[] = []) => {
      requetes.push({ texte, valeurs });
      if (/INSERT INTO a_trancher/.test(texte)) {
        if (!/WHERE NOT EXISTS/.test(texte)) { cles.add(String(Math.random())); return { rows: [{ id: "x" }] }; }
        const cle = String(valeurs[valeurs.length - 1]);
        // Le NOT EXISTS ne voit que les lignes ouvertes quand il filtre sur etat = 'ouvert'.
        const vue = cles.has(cle) && (!/etat = 'ouvert'/.test(texte) || etats.get(cle) === "ouvert");
        if (vue) return { rows: [] };
        cles.add(cle); etats.set(cle, "ouvert"); inserees.push(cle); return { rows: [{ id: "x" }] };
      }
      if (/^UPDATE phases_plan/.test(texte)) return { rows: opts.phaseLiee === undefined && !opts.phaseAbsente ? [{ id: PHASE }] : [] };
      if (/FROM phases_plan/.test(texte)) return { rows: opts.phaseAbsente ? [] : [{ id_plan_hub: opts.phaseLiee ?? null }] };
      return { rows: [] };
    },
  };
  const alerter = async (a: { niveau: "critique"; code: string }) => void alertes.push(a);
  return { tx, requetes, cles, etats, inserees, alertes, alerter };
}

describe("réponses du Hub rangées par route", () => {
  it("[C-456] une réponse a_trancher range une ligne a_trancher (siren_absent_ressemblance) sans créer d'axiCli", async () => {
    const b = banc();
    const r = await traiterReponse(b.tx, TENANT, { route: "clients-retrouver-ou-creer", statut: 202, corps: { resultat: "a_trancher", idDemande: "demande-1" } });
    expect(r).toEqual({ rangee: "a_trancher" });
    expect(b.requetes).toHaveLength(1);
    expect(b.requetes[0]!.texte).toMatch(/INSERT INTO a_trancher/);
    expect(b.requetes[0]!.valeurs).toContain("siren_absent_ressemblance");
    expect(b.requetes.some((q) => /UPDATE|organisations/.test(q.texte))).toBe(false);
  });

  it("[C-338] 422 fiche_absorbee et 409 identifiant_deja_pris partent dans à trancher (motif fiche_absorbee)", async () => {
    for (const [statut, code] of [[422, "fiche_absorbee"], [409, "identifiant_deja_pris"]] as const) {
      const b = banc();
      const r = await traiterReponse(b.tx, TENANT, { route: "clients-statut", statut, corps: { erreur: { code, message: "x", id_trace: "t" } } });
      expect(r).toEqual({ rangee: "a_trancher" });
      expect(b.requetes[0]!.valeurs).toContain("fiche_absorbee");
    }
  });

  it("[C-361] retrouvé ou créé : l'axiCli est rendu à l'appelant, rien n'est écrit dans une fiche absorbée", async () => {
    const b = banc();
    const r = await traiterReponse(b.tx, TENANT, { route: "clients-retrouver-ou-creer", statut: 200, corps: { resultat: "cree", axiCli: "AXI-CLI-000101" } });
    expect(r).toEqual({ axiCli: "AXI-CLI-000101" });
    expect(b.requetes).toHaveLength(0);
  });

  it("[C-455] la réponse d'un plan est rangée dans phases_plan.id_plan_hub sans jamais écraser un plan déjà lié", async () => {
    const b = banc();
    await traiterReponse(b.tx, TENANT, { route: "plans-recurrents", statut: 201, corps: { idPlan: "plan-101" }, phaseId: PHASE });
    expect(b.requetes[0]!.texte).toMatch(/UPDATE phases_plan SET id_plan_hub = \$1 WHERE tenant_id = \$2 AND id = \$3 AND id_plan_hub IS NULL/);
  });

  it("[C-455] une réponse hors schéma est refusée, rien n'est rangé", async () => {
    const b = banc();
    await expect(traiterReponse(b.tx, TENANT, { route: "plans-recurrents", statut: 201, corps: { idPlan: 12, en_trop: true }, phaseId: PHASE })).rejects.toThrow();
    expect(b.requetes).toHaveLength(0);
  });

  it("[C-456] rejouer le même 202 ne range qu'une ligne a_trancher (WHERE NOT EXISTS sur idDemande)", async () => {
    const b = banc();
    const r = { route: "clients-retrouver-ou-creer", statut: 202, corps: { resultat: "a_trancher", idDemande: "demande-1" } };
    await traiterReponse(b.tx, TENANT, r); await traiterReponse(b.tx, TENANT, r);
    expect(b.cles.size).toBe(1);
    expect(b.requetes[0]!.texte).toMatch(/WHERE NOT EXISTS \(SELECT 1 FROM a_trancher WHERE tenant_id = \$1::uuid AND source = 'hub' AND donnees_comparaison->>'idDemande' = \$4\)/);
    await traiterReponse(b.tx, TENANT, { ...r, corps: { resultat: "a_trancher", idDemande: "demande-2" } });
    expect(b.cles.size).toBe(2);
  });

  it("[C-456] retraiter la même réponse 202 après la décision de l'équipe ne crée aucune ligne", async () => {
    const b = banc();
    const r = { route: "clients-retrouver-ou-creer", statut: 202, corps: { resultat: "a_trancher", idDemande: "demande-1" } };
    await traiterReponse(b.tx, TENANT, r);
    b.etats.set("demande-1", "tranche");
    await traiterReponse(b.tx, TENANT, r);
    expect(b.inserees).toEqual(["demande-1"]);
  });

  it("[C-338] un rejeu du même 409 ou 422 sur le statut ne range qu'une ligne, rangée sous l'intention déposée, avec l'axiCli dans les données", async () => {
    const b = banc();
    const r = { route: "clients-statut", statut: 422, axiCli: "AXI-CLI-000101", intention: "statut:T:AXI-CLI-000101:client_actif:h-1", corps: { erreur: { code: "fiche_absorbee", message: "x", id_trace: "t" } } };
    await traiterReponse(b.tx, TENANT, r); await traiterReponse(b.tx, TENANT, r);
    expect(b.cles.size).toBe(1);
    expect(String(b.requetes[0]!.valeurs[2])).toContain("AXI-CLI-000101");
    expect(b.requetes[0]!.valeurs[3]).toBe("statut:T:AXI-CLI-000101:client_actif:h-1");
    await traiterReponse(b.tx, TENANT, { ...r, intention: "statut:T:AXI-CLI-000101:ancien_client:h-2" });
    expect(b.cles.size).toBe(2);
  });

  it("[C-338] un 409 ou 422 sur le statut sans axiCli est refusé : plus de statut:inconnu", async () => {
    const b = banc();
    await expect(traiterReponse(b.tx, TENANT, { route: "clients-statut", statut: 422, intention: "statut:T:x:client_actif:h-1", corps: { erreur: { code: "fiche_absorbee", message: "x", id_trace: "t" } } })).rejects.toThrow(/axiCli/);
    expect(b.requetes).toHaveLength(0);
  });

  it("[C-338] fiche_absorbee ou identifiant_deja_pris sur retrouver-ou-creer part dans à trancher, rangé sous l'intention déposée, sans ZodError", async () => {
    for (const [statut, code] of [[422, "fiche_absorbee"], [409, "identifiant_deja_pris"]] as const) {
      const b = banc();
      const r = await traiterReponse(b.tx, TENANT, { route: "clients-retrouver-ou-creer", statut, intention: "retrouver:T:abc", corps: { erreur: { code, message: "x", id_trace: "t" } } });
      expect(r).toEqual({ rangee: "a_trancher" });
      expect(b.requetes[0]!.valeurs).toContain("fiche_absorbee");
      expect(b.requetes[0]!.valeurs[3]).toBe("retrouver:T:abc");
    }
  });

  it("[C-455] @argent un plan déjà lié à un AUTRE idPlan lève une alerte critique au lieu d'être ignoré ; le même idPlan rejoué est sans effet", async () => {
    const b = banc({ phaseLiee: "plan-ancien" });
    const r = await traiterReponse(b.tx, TENANT, { route: "plans-recurrents", statut: 201, corps: { idPlan: "plan-101" }, phaseId: PHASE }, b.alerter);
    expect(r).toEqual({ rangee: "alerte" });
    expect(b.alertes).toEqual([{ niveau: "critique", code: "plan_hub_deja_lie_autre", phaseId: PHASE, idPlan: "plan-101" }]);
    await expect(traiterReponse(b.tx, TENANT, { route: "plans-recurrents", statut: 201, corps: { idPlan: "plan-101" }, phaseId: PHASE })).rejects.toThrow(/plan déjà lié/);
    const memes = banc({ phaseLiee: "plan-101" });
    expect(await traiterReponse(memes.tx, TENANT, { route: "plans-recurrents", statut: 201, corps: { idPlan: "plan-101" }, phaseId: PHASE }, memes.alerter)).toEqual({ rangee: "plan" });
    expect(memes.alertes).toEqual([]);
  });

  it("[C-455] clore : des brouillons non émis lèvent une alerte critique, sans rien supprimer", async () => {
    const b = banc();
    const r = await traiterReponse(b.tx, TENANT, { route: "plans-recurrents-clore", statut: 200, corps: { idPlan: "plan-101", brouillonsNonEmis: ["fac-1", "fac-2"] } }, b.alerter);
    expect(r).toEqual({ rangee: "alerte" });
    expect(b.alertes).toEqual([{ niveau: "critique", code: "clore_brouillons_non_emis", idPlan: "plan-101", nombre: 2 }]);
    expect(b.requetes.some((q) => /DELETE|UPDATE/.test(q.texte))).toBe(false);
    const vide = banc();
    expect(await traiterReponse(vide.tx, TENANT, { route: "plans-recurrents-clore", statut: 200, corps: { idPlan: "plan-101", brouillonsNonEmis: [] } }, vide.alerter)).toEqual({ rangee: "rien" });
    expect(vide.alertes).toEqual([]);
    await expect(traiterReponse(vide.tx, TENANT, { route: "plans-recurrents-clore", statut: 200, corps: { idPlan: "plan-101" } }, vide.alerter)).rejects.toThrow();
  });
});
