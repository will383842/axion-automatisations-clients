import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { rangerCleClient } from "./cle-client.js";

// Faux coffre : garde les appels, rend une référence de la forme du vrai coffre. Valeur de clé = marqueur unique généré, jamais une forme de vraie clé.
function fauxCoffre(montage = "clients") {
  const appels: { tenantId: string; nom: string; valeur: string }[] = [];
  return {
    appels,
    async rangerIdentifiant(tenantId: string, nom: string, valeur: string) {
      appels.push({ tenantId, nom, valeur });
      return `bao:${montage}/${tenantId}/${randomUUID()}`;
    },
  };
}

describe("clé d'IA propre du client (T4-34a)", () => {
  it("[C-635] la clé du client est rangée sous une référence bao:clients/<tenantId>/<uuid>, jamais sous le montage technique/ d'AXION IA", async () => {
    const A = randomUUID();
    const coffre = fauxCoffre();
    const enregistrees: { reference: string; fournisseur: string }[] = [];
    const marqueur = `essai-cle-${randomUUID()}`;
    const r = await rangerCleClient(
      { coffre, enregistrer: async (e) => (enregistrees.push(e), { id: randomUUID() }) },
      { tenantId: A, organisationId: A, fournisseur: "mistral", valeur: marqueur, acteur: "agent-essai" },
    );
    expect(coffre.appels).toEqual([{ tenantId: A, nom: "ia:mistral", valeur: marqueur }]);
    expect(enregistrees[0]?.reference).toMatch(new RegExp(`^bao:clients/${A}/[0-9a-f-]{36}$`));
    expect(enregistrees[0]?.reference).not.toContain("technique/");
    // Ni la valeur ni la référence ne reviennent à l'appelant : l'état seulement.
    expect(JSON.stringify(r)).not.toContain(marqueur);
    expect(r).toMatchObject({ fournisseur: "mistral", etat: "a_tester" });
    expect(Object.keys(r).sort()).toEqual(["etat", "fournisseur", "id"]);
  });

  it("[C-635] une référence rendue hors du montage du client est refusée et rien n'est enregistré", async () => {
    const A = randomUUID();
    let enregistre = false;
    const marqueur = `essai-cle-${randomUUID()}`;
    for (const coffre of [fauxCoffre("technique"), { async rangerIdentifiant() { return `bao:clients/${randomUUID()}/${randomUUID()}`; } }]) {
      const e = await rangerCleClient(
        { coffre, enregistrer: async () => ((enregistre = true), { id: randomUUID() }) },
        { tenantId: A, organisationId: A, fournisseur: "mistral", valeur: marqueur, acteur: "agent-essai" },
      ).catch((x: unknown) => x as Error);
      expect(e).toBeInstanceOf(Error);
      expect(String((e as Error).message)).not.toContain(marqueur);
    }
    expect(enregistre).toBe(false);
  });

  it("[A-364] une erreur du coffre ne recopie pas la valeur de la clé", async () => {
    const marqueur = `essai-cle-${randomUUID()}`;
    const coffre = { async rangerIdentifiant(_t: string, _n: string, v: string): Promise<string> { throw new Error(`refus pour ${v}`); } };
    const e = await rangerCleClient(
      { coffre, enregistrer: async () => ({ id: randomUUID() }) },
      { tenantId: randomUUID(), organisationId: randomUUID(), fournisseur: "mistral", valeur: marqueur, acteur: "agent-essai" },
    ).catch((x: unknown) => x as Error);
    expect(String((e as Error).message)).not.toContain(marqueur);
    expect(String((e as Error).stack)).not.toContain(marqueur);
  });
});
