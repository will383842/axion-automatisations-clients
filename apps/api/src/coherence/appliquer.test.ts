import { describe, expect, it, vi } from "vitest";
import { appliquerProposition, ecarterProposition, type DepsAppliquer, type LigneATrancher } from "./appliquer.js";

const T1 = "11111111-1111-4111-8111-111111111111";
const ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ligne = (action: string, cible: "hub" | "crm" | "console", etat: "ouvert" | "tranche" = "ouvert"): LigneATrancher => ({ id: ID, tenantId: T1, motif: "incoherence_nuit", etat, proposition: { action, cible, avant: {}, apres: {} } });
const appelant = { acteur: "equipe-essai", ip: "203.0.113.7" };

function deps(l: LigneATrancher | null, ok = true) {
  const requetes: { sql: string; valeurs: unknown[] }[] = [];
  const passes: { tenantId: string; appelant: unknown }[] = [];
  const executeur = vi.fn(async () => undefined);
  const d: DepsAppliquer = {
    charger: async () => l,
    transaction: async (tenantId, a, fn) => { passes.push({ tenantId, appelant: a }); return fn({ query: async (sql: string, valeurs: unknown[] = []) => { requetes.push({ sql, valeurs }); return { rowCount: ok ? 1 : 0, rows: [] }; } } as never); },
    executeurs: { aligner_statut_hub: executeur, creer_fiche_hub: executeur },
  };
  return { d, requetes, passes, executeur };
}

describe("appliquer une proposition", () => {
  it("[C-365] l'équipe applique la proposition d'un clic ; l'action est tracée", async () => {
    const { d, requetes, passes, executeur } = deps(ligne("aligner_statut_hub", "hub"));
    await appliquerProposition(d, ID, appelant, true);
    expect(executeur).toHaveBeenCalledTimes(1);
    expect(passes).toEqual([{ tenantId: T1, appelant }]);
    expect(requetes).toHaveLength(1);
    expect(requetes[0]?.sql).toMatch(/UPDATE a_trancher SET etat = 'tranche'/);
    expect(requetes[0]?.valeurs).toEqual([ID, "equipe-essai", "applique:aligner_statut_hub"]);
  });

  it("[C-365] une action qui écrit hors console exige la réauthentification, et rien ne part sans elle", async () => {
    const { d, executeur } = deps(ligne("aligner_statut_hub", "hub"));
    await expect(appliquerProposition(d, ID, appelant, false)).rejects.toMatchObject({ code: "reauthentification_requise" });
    expect(executeur).not.toHaveBeenCalled();
  });

  it("[C-365] une ligne déjà tranchée, absente ou sans exécuteur (à examiner à la main) n'applique rien", async () => {
    const e1 = deps(ligne("aligner_statut_hub", "hub", "tranche"));
    await expect(appliquerProposition(e1.d, ID, appelant, true)).rejects.toMatchObject({ code: "regle_metier", message: expect.stringContaining("tranchée") });
    await expect(appliquerProposition(deps(null).d, ID, appelant, true)).rejects.toMatchObject({ code: "introuvable" });
    const e3 = deps(ligne("a_examiner", "console"));
    await expect(appliquerProposition(e3.d, ID, appelant, true)).rejects.toMatchObject({ code: "regle_metier", message: expect.stringContaining("à la main") });
    expect(e3.executeur).not.toHaveBeenCalled();
  });

  it("[C-365] si la ligne a été fermée entre-temps, l'action n'est pas gardée (transaction annulée)", async () => {
    const { d } = deps(ligne("aligner_statut_hub", "hub"), false);
    await expect(appliquerProposition(d, ID, appelant, true)).rejects.toMatchObject({ code: "regle_metier", message: expect.stringContaining("tranchée") });
  });

  it("[C-365] écarter exige un motif, ferme la ligne et n'exécute rien", async () => {
    const { d, requetes, executeur } = deps(ligne("aligner_statut_hub", "hub"));
    await expect(ecarterProposition(d, ID, appelant, "  ")).rejects.toMatchObject({ code: "schema_invalide" });
    await ecarterProposition(d, ID, appelant, "déjà corrigé à la main");
    expect(executeur).not.toHaveBeenCalled();
    expect(requetes[0]?.valeurs).toEqual([ID, "equipe-essai", "ecarte:déjà corrigé à la main"]);
  });
});
