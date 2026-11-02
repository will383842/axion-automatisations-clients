import { describe, expect, it } from "vitest";
import { traiterReponse } from "./reponses.ts";

const TENANT = "11111111-1111-4111-8111-111111111111";
function banc() {
  const requetes: { texte: string; valeurs: unknown[] }[] = [];
  const tx = { query: async (texte: string, valeurs: unknown[] = []) => { requetes.push({ texte, valeurs }); return { rows: [] }; } };
  return { tx, requetes };
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
    await traiterReponse(b.tx, TENANT, { route: "plans-recurrents", statut: 201, corps: { idPlan: "plan-101" }, phaseId: "33333333-3333-4333-8333-333333333333" });
    expect(b.requetes[0]!.texte).toMatch(/UPDATE phases_plan SET id_plan_hub = \$1 WHERE tenant_id = \$2 AND id = \$3 AND id_plan_hub IS NULL/);
  });

  it("[C-455] une réponse hors schéma est refusée, rien n'est rangé", async () => {
    const b = banc();
    await expect(traiterReponse(b.tx, TENANT, { route: "plans-recurrents", statut: 201, corps: { idPlan: 12, en_trop: true }, phaseId: "33333333-3333-4333-8333-333333333333" })).rejects.toThrow();
    expect(b.requetes).toHaveLength(0);
  });
});
