import { describe, expect, it, vi } from "vitest";
import { appliquerProposition, ecarterProposition, type DepsAppliquer, type EtatCourant, type LigneATrancher } from "./appliquer.js";

const T1 = "11111111-1111-4111-8111-111111111111";
const ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ligne = (action: string, cible: "hub" | "crm" | "console", etat: "ouvert" | "tranche" = "ouvert", avant: Record<string, string | null> = {}, apres: Record<string, string | null> = {}): LigneATrancher => ({ id: ID, tenantId: T1, motif: "incoherence_nuit", etat, proposition: { action, cible, avant, apres } });
const appelant = { acteur: "equipe-essai", ip: "203.0.113.7" };

// Par défaut l'état relu est celui que la nuit avait vu : le maître porte encore la valeur proposée, la cible l'ancienne.
function deps(l: LigneATrancher | null, ok = true, etat?: EtatCourant) {
  const requetes: { sql: string; valeurs: unknown[] }[] = [];
  const passes: { tenantId: string; appelant: unknown }[] = [];
  const executeur = vi.fn(async () => undefined);
  const d: DepsAppliquer = {
    charger: async () => l,
    transaction: async (tenantId, a, fn) => { passes.push({ tenantId, appelant: a }); return fn({ query: async (sql: string, valeurs: unknown[] = []) => { requetes.push({ sql, valeurs }); return { rowCount: ok ? 1 : 0, rows: [] }; } } as never); },
    executeurs: { aligner_statut_hub: executeur, creer_fiche_hub: executeur, demander_fusion_crm: executeur },
    lireEtat: vi.fn(async () => etat ?? { maitre: l?.proposition.apres ?? {}, cible: l?.proposition.avant ?? {} }),
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

  it("[C-365] proposition périmée : si la valeur du maître a changé depuis la nuit, rien n'est appliqué", async () => {
    const l = ligne("aligner_statut_hub", "hub", "ouvert", { statut: "client_actif" }, { statut: "ancien_client" });
    const e = deps(l, true, { maitre: { statut: "client_actif" }, cible: { statut: "client_actif" } });
    await expect(appliquerProposition(e.d, ID, appelant, true)).rejects.toMatchObject({ code: "regle_metier", message: expect.stringContaining("a changé") });
    expect(e.executeur).not.toHaveBeenCalled();
    expect(e.requetes).toEqual([]);
  });

  it("[C-365] proposition périmée : si l'écart a disparu (la cible porte déjà la valeur proposée), rien n'est appliqué", async () => {
    const l = ligne("aligner_statut_hub", "hub", "ouvert", { statut: "client_actif" }, { statut: "ancien_client" });
    const e = deps(l, true, { maitre: { statut: "ancien_client" }, cible: { statut: "ancien_client" } });
    await expect(appliquerProposition(e.d, ID, appelant, true)).rejects.toMatchObject({ code: "regle_metier", message: expect.stringContaining("déjà réglé") });
    expect(e.executeur).not.toHaveBeenCalled();
  });

  it("[C-365] proposition périmée : si la cible n'est plus dans l'état d'avant, rien n'est appliqué ; si tout correspond, l'état est relu dans la transaction", async () => {
    const l = ligne("aligner_statut_hub", "hub", "ouvert", { statut: "client_actif" }, { statut: "ancien_client" });
    const refus = deps(l, true, { maitre: { statut: "ancien_client" }, cible: { statut: "prospect" } });
    await expect(appliquerProposition(refus.d, ID, appelant, true)).rejects.toMatchObject({ code: "regle_metier", message: expect.stringContaining("a changé") });
    expect(refus.executeur).not.toHaveBeenCalled();
    const bon = deps(l, true, { maitre: { statut: "ancien_client" }, cible: { statut: "client_actif" } });
    await appliquerProposition(bon.d, ID, appelant, true);
    expect(bon.executeur).toHaveBeenCalledTimes(1);
    expect(bon.passes).toHaveLength(1);
    expect(bon.d.lireEtat).toHaveBeenCalledTimes(1);
  });

  it("[C-365] une action absente de la liste n'est pas trouvée par un nom hérité de l'objet (toString, constructor, __proto__)", async () => {
    for (const nom of ["toString", "constructor", "hasOwnProperty", "__proto__"]) {
      const e = deps(ligne(nom, "console"));
      await expect(appliquerProposition(e.d, ID, appelant, true), nom).rejects.toMatchObject({ code: "regle_metier", message: expect.stringContaining("à la main") });
      expect(e.executeur).not.toHaveBeenCalled();
    }
  });

  it("[C-365] demander_fusion_crm : aucune fusion tant que l'équipe n'a pas choisi la fiche gardée", async () => {
    const sans = deps(ligne("demander_fusion_crm", "crm", "ouvert", { fiches: "c1,c2" }, { gardee: null }));
    await expect(appliquerProposition(sans.d, ID, appelant, true)).rejects.toMatchObject({ code: "regle_metier", message: expect.stringContaining("fiche gardée") });
    expect(sans.executeur).not.toHaveBeenCalled();
    expect(sans.passes).toEqual([]);
  });
});
