import { describe, expect, it } from "vitest";
import { creerTransactionsMemoire } from "./transactions.js";

const NOUVELLE = { sujet: "personne-1", tenantId: "11111111-1111-4111-8111-111111111111", connexionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", outil: "microsoft-365", fournisseur: "microsoft", genre: "autorisation", locataire: "22222222-2222-4222-8222-222222222222" } as const;

describe("transactions OAuth en mémoire", () => {
  it("[A-388] une transaction ne sert qu'une fois, échoit au bout de 10 minutes, et le plafond retire la plus ancienne", async () => {
    let t = 1_800_000_000_000;
    const m = creerTransactionsMemoire({ maintenant: () => t });
    const a = await m.creer(NOUVELLE);
    expect(a.state).not.toBe((await m.creer(NOUVELLE)).state);
    expect(a.verifier.length).toBeGreaterThanOrEqual(43);
    expect(String(a)).not.toContain(a.state);
    expect(JSON.stringify(a)).not.toContain(a.verifier);
    expect((await m.prendre(a.state))?.connexionId).toBe(NOUVELLE.connexionId);
    expect(await m.prendre(a.state)).toBeNull();
    const b = await m.creer(NOUVELLE);
    t += 10 * 60_000 + 1;
    const prise = await m.prendre(b.state);
    expect(prise !== null && prise.echeance < t).toBe(true);
    const premiere = await m.creer(NOUVELLE);
    for (let i = 0; i < 1000; i++) await m.creer(NOUVELLE);
    expect(m.taille()).toBe(1000);
    expect(await m.prendre(premiere.state)).toBeNull();
  });
});
