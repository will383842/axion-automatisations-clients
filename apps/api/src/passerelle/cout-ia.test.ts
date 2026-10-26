import { describe, expect, it } from "vitest";
import { coutAppel, creerGardeBoucle, ErreurCoutIa, lireModeIa, TABLEAU_EXEMPLE, type TableauCouts } from "./cout-ia.js";

// Taux d'EXEMPLE (nombres ronds sans rapport avec un vrai prix) ; les valeurs de travail restent dans le dépôt privé.
const T: TableauCouts = {
  statut: "PROVISOIRE",
  lignes: { "modele-a": { entree: 2, sortie: 4, statut: "PROVISOIRE" }, "modele-b": { entree: 1, sortie: 1, statut: "RELEVE" } },
};
const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";
const refus = (f: () => unknown, code: string) => {
  try { f(); } catch (e) { expect(e).toBeInstanceOf(ErreurCoutIa); expect((e as ErreurCoutIa).code).toBe(code); return; }
  throw new Error("aucun refus");
};

describe("coût d'IA provisoire et mode d'IA", () => {
  it("[C-526] le coût d'un appel vient du tableau : (entrée × prix entrée + sortie × prix sortie) / 1 000 000", () => {
    const r = coutAppel(T, "modele-a", { jetonsEntree: 500_000, jetonsSortie: 250_000 });
    expect(r.cout).toBe(2);
    expect(r.provisoire).toBe(true);
  });
  it("[C-526] une ligne RELEVE n'est plus marquée provisoire", () => {
    expect(coutAppel(T, "modele-b", { jetonsEntree: 1_000_000, jetonsSortie: 0 })).toEqual({ cout: 1, provisoire: false });
  });
  it("[C-526] jamais bloquant : modèle inconnu ou jetons invalides donnent un coût nul marqué inconnu, sans exception", () => {
    expect(coutAppel(T, "inconnu", { jetonsEntree: 10, jetonsSortie: 10 })).toEqual({ cout: 0, provisoire: true, inconnu: true });
    expect(coutAppel(T, "modele-a", { jetonsEntree: -1, jetonsSortie: Number.NaN }).inconnu).toBe(true);
  });
  it("[C-526] le tableau d'exemple public ne porte que des valeurs fictives marquées PROVISOIRE", () => {
    expect(TABLEAU_EXEMPLE.statut).toBe("PROVISOIRE");
    for (const l of Object.values(TABLEAU_EXEMPLE.lignes)) { expect(l.statut).toBe("PROVISOIRE"); expect(l.entree).toBe(1); expect(l.sortie).toBe(1); }
  });
  it("[C-526] mode_ia vaut client_direct ou via_axion, rien d'autre ; absent = refus", () => {
    expect(lireModeIa("client_direct")).toBe("client_direct");
    expect(lireModeIa("via_axion")).toBe("via_axion");
    refus(() => lireModeIa("autre"), "mode_ia_invalide");
    refus(() => lireModeIa(undefined), "mode_ia_invalide");
  });
  it("[C-526] le garde-fou anti-boucle refuse le N-ième appel identique consécutif, dans les deux modes", () => {
    for (const mode of ["client_direct", "via_axion"] as const) {
      const g = creerGardeBoucle({ identiquesMax: 3, parMinuteMax: 100, parHeureMax: 1000, horloge: () => 0 });
      expect(g.verifier(mode, T1, "auto-1", "h1")).toEqual({ autorise: true });
      expect(g.verifier(mode, T1, "auto-1", "h1")).toEqual({ autorise: true });
      expect(g.verifier(mode, T1, "auto-1", "h1")).toEqual({ autorise: false, motif: "appels_identiques" });
    }
  });
  it("[C-526] le garde-fou plafonne les appels par minute et par heure ; une autre automatisation n'est pas touchée", () => {
    let t = 0;
    const g = creerGardeBoucle({ identiquesMax: 99, parMinuteMax: 2, parHeureMax: 3, horloge: () => t });
    expect(g.verifier("via_axion", T1, "a", "1").autorise).toBe(true);
    expect(g.verifier("via_axion", T1, "a", "2").autorise).toBe(true);
    expect(g.verifier("via_axion", T1, "a", "3")).toEqual({ autorise: false, motif: "plafond_minute" });
    expect(g.verifier("via_axion", T1, "b", "1").autorise).toBe(true);
    t = 61_000;
    expect(g.verifier("via_axion", T1, "a", "4").autorise).toBe(true);
    t = 120_000;
    expect(g.verifier("via_axion", T1, "a", "5")).toEqual({ autorise: false, motif: "plafond_heure" });
  });
  it("[C-526] un blocage reste en place jusqu'à la levée par un administrateur", () => {
    const g = creerGardeBoucle({ identiquesMax: 2, parMinuteMax: 9, parHeureMax: 9, horloge: () => 0 });
    expect(g.verifier("client_direct", T1, "a", "x").autorise).toBe(true);
    expect(g.verifier("client_direct", T1, "a", "x").autorise).toBe(false);
    expect(g.verifier("client_direct", T1, "a", "y")).toEqual({ autorise: false, motif: "bloque" });
    g.lever(T1, "a");
    expect(g.verifier("client_direct", T1, "a", "y").autorise).toBe(true);
  });
  it("[C-526] trois appels identiques espacés de 24 h sont tous autorisés (fenêtre glissante)", () => {
    let t = 0;
    const g = creerGardeBoucle({ identiquesMax: 3, parMinuteMax: 100, parHeureMax: 1000, horloge: () => t });
    for (let j = 0; j < 4; j++) { t = j * 86_400_000; expect(g.verifier("via_axion", T1, "resume", "h1")).toEqual({ autorise: true }); }
  });
  it("[C-526] @isolation : une boucle chez un client ne bloque ni ne décompte l'autre ; lever ne touche que son client", () => {
    const g = creerGardeBoucle({ identiquesMax: 2, parMinuteMax: 2, parHeureMax: 9, horloge: () => 0 });
    expect(g.verifier("via_axion", T1, "relance", "h").autorise).toBe(true);
    expect(g.verifier("via_axion", T1, "relance", "h").autorise).toBe(false);
    expect(g.verifier("via_axion", T2, "relance", "h")).toEqual({ autorise: true });
    expect(g.verifier("via_axion", T2, "relance", "z")).toEqual({ autorise: true });
    g.lever(T2, "relance");
    expect(g.verifier("via_axion", T1, "relance", "h")).toEqual({ autorise: false, motif: "bloque" });
  });
  it("[C-526] options invalides : refusées à la création, jamais un garde-fou éteint en silence", () => {
    const ok = { identiquesMax: 3, parMinuteMax: 5, parHeureMax: 50, horloge: () => 0 };
    for (const mauvais of [{ identiquesMax: Number.NaN }, { identiquesMax: 1 }, { parMinuteMax: Number.NaN }, { parMinuteMax: 0 }, { parHeureMax: Number.POSITIVE_INFINITY }, { parHeureMax: 1.5 }, { fenetreIdentiquesMs: 0 }]) {
      refus(() => creerGardeBoucle({ ...ok, ...mauvais }), "options_garde_invalides");
    }
  });
  it("[C-526] le tenant est validé", () => {
    const g = creerGardeBoucle({ identiquesMax: 3, parMinuteMax: 5, parHeureMax: 50, horloge: () => 0 });
    expect(() => g.verifier("via_axion", "", "a", "h")).toThrow();
  });
});
