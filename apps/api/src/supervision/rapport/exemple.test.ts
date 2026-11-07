import { describe, expect, it } from "vitest";
import { exempleOmis, ExempleHorsClient, lireExempleDuClient, type ExempleRapport } from "./exemple.js";

const TA = "11111111-1111-4111-8111-111111111111";
const TB = "22222222-2222-4222-8222-222222222222";

describe("exemple concret du rapport", () => {
  it("[B-408] exemple : port qui rend undefined → rubrique omise (V1 : adaptateur qui n'en lit aucun)", async () => {
    expect(await lireExempleDuClient(exempleOmis, TA)).toBeUndefined();
    const vide: ExempleRapport = { lire: async () => undefined };
    expect(await lireExempleDuClient(vide, TA)).toBeUndefined();
  });

  it("[B-408] exemple d'un autre client → erreur, aucune valeur rendue", async () => {
    const mauvais: ExempleRapport = { lire: async () => ({ tenantId: TB, titre: "MARQUE-B-titre", texte: "MARQUE-B-texte" }) };
    await expect(lireExempleDuClient(mauvais, TA)).rejects.toBeInstanceOf(ExempleHorsClient);
  });

  it("[B-408] le port est appelé avec le client du rapport et l'exemple est nettoyé et borné", async () => {
    const appels: string[] = [];
    const port: ExempleRapport = { lire: async (t) => { appels.push(t); return { tenantId: t, titre: "Devis\u0000 relancé", texte: "x".repeat(1000) }; } };
    const e = await lireExempleDuClient(port, TA);
    expect(appels).toEqual([TA]);
    expect(e?.titre).toBe("Devis relancé");
    expect(e?.texte.length).toBe(500);
  });
});
