import { describe, expect, it } from "vitest";
import { validerPalier } from "./paliers.js";

// Paliers en résultats (C-205) : un palier se dit en résultats livrés (e-mails, devis, dossiers), jamais en IA, jetons ou modèles.
// La liste des mots refusés n'est pas exhaustive par nature (règle 9.4) : sa limite est écrite dans la PR.
describe("paliers en résultats", () => {
  const REFUSES: [string, string][] = [
    ["IA", "e-mails par mois"],
    ["i.a.", "résultats"],
    ["I A", "dossiers"],
    ["Intelligence Artificielle", "devis"],
    ["jetons", "par mois"],
    ["Tokens", "par mois"],
    ["modèle", "devis"],
    ["LLM", "par mois"],
    ["GPT", "par mois"],
    ["crédits", "par mois"],
    ["UIA", "par mois"],
    ["prompt", "par mois"],
  ];
  it("[C-205] un palier exprimé en IA est refusé", () => {
    for (const [mot, autre] of REFUSES) {
      expect(validerPalier({ quantite: 300, unite: mot, libelle: autre }).ok, `unité « ${mot} »`).toBe(false);
      expect(validerPalier({ quantite: 300, unite: autre, libelle: `Jusqu'à 300 ${mot}` }).ok, `libellé avec « ${mot} »`).toBe(false);
    }
    expect(validerPalier({ quantite: 300, unite: "e‑mails", libelle: "Envoi par I A" }).ok).toBe(false);
  });

  it("[C-205] un palier en résultats est accepté", () => {
    expect(validerPalier({ quantite: 300, unite: "e-mails par mois", libelle: "Départ" })).toEqual({ ok: true, palier: { quantite: 300, unite: "e-mails par mois", libelle: "Départ" } });
    expect(validerPalier({ quantite: null, unite: "résultats", libelle: "usage étendu" })).toEqual({ ok: true, palier: { quantite: null, unite: "résultats", libelle: "usage étendu" } });
    expect(validerPalier({ quantite: 1_000_000_000, unite: "dossiers", libelle: "Plafond" }).ok).toBe(true);
  });

  it("[C-205] une quantité nulle, négative, décimale ou au-delà d'un milliard est refusée", () => {
    const mauvaises: unknown[] = [0, -1, 1.5, 1_000_000_001, Number.NaN, Infinity, "300", undefined, true, 1e21];
    for (const quantite of mauvaises) expect(validerPalier({ quantite, unite: "dossiers", libelle: "Départ" } as never).ok, String(quantite)).toBe(false);
    for (const texte of ["", "   ", "x".repeat(81), 12, null]) {
      expect(validerPalier({ quantite: 1, unite: texte, libelle: "Départ" } as never).ok, `unité ${String(texte)}`).toBe(false);
      expect(validerPalier({ quantite: 1, unite: "dossiers", libelle: texte } as never).ok, `libellé ${String(texte)}`).toBe(false);
    }
  });
});
