import { describe, expect, it } from "vitest";
import { rangerApporteurs } from "./apporteurs.ts";

const TENANT = "11111111-1111-4111-8111-111111111111";
describe("apporteurs lus dans le Hub", () => {
  it("[A-147] les apporteurs lus dans le Hub sont rangés avec leur date de lecture, sans toucher aux taux", async () => {
    const requetes: { texte: string; valeurs: unknown[] }[] = [];
    const tx = { query: async (texte: string, valeurs: unknown[] = []) => { requetes.push({ texte, valeurs }); return { rows: [{ apporteur_axion_ia_id: "app-1" }] }; } };
    const lu = new Date("2026-11-02T03:00:00Z");
    const r = await rangerApporteurs(tx, TENANT, { apporteurs: [{ idApporteur: "app-1", nom: "Immobilière Marceau" }, { idApporteur: "app-2", nom: "Garage Fontaine" }] }, lu);
    expect(requetes[0]!.texte).toMatch(/UPDATE apporteurs_clients SET lu_le = GREATEST\(lu_le, \$1\)/);
    expect(requetes[0]!.texte).not.toMatch(/taux_points_de_base|commissions_dues_centimes|siren/);
    expect(requetes[0]!.valeurs[0]).toEqual(lu);
    expect(r).toEqual({ mis_a_jour: ["app-1"], inconnus: ["app-2"] });
  });

  it("[A-147] une réponse hors schéma est refusée", async () => {
    await expect(rangerApporteurs({ query: async () => ({ rows: [] }) }, TENANT, { apporteurs: [{ idApporteur: 1 }] }, new Date())).rejects.toThrow();
  });
});
