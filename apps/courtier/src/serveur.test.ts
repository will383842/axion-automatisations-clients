import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { creerJournal } from "./journal.js";
import { creerRegistreJetons } from "./jetons.js";
import { creerServeur } from "./serveur.js";

const INSTANCE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const EXEC = "22222222-2222-4222-8222-222222222222";
const CONN = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

describe("serveur du courtier", () => {
  it("[C-014] le jeton d'instance est lu dans « Authorization: Instance <jeton> » (fiche T4-21)", async () => {
    const vus: string[] = [];
    const serveur = creerServeur({
      verifierSignature: async () => "cellule-1",
      verifierJetonInstance: async (jeton) => { vus.push(jeton); return false; },
      executionEnCours: async () => false,
      connexion: async () => undefined,
      lireCoffre: async () => ({}),
      jetons: creerRegistreJetons(),
      journal: creerJournal(() => undefined),
      maintenant: () => Date.now(),
      dureeExecutionMs: 1000,
    });
    await new Promise<void>((ok) => serveur.listen(0, "127.0.0.1", ok));
    try {
      const { port } = serveur.address() as AddressInfo;
      const corps = JSON.stringify({ instanceId: INSTANCE, executionId: EXEC, connexionId: CONN });
      const appel = (entetes: Record<string, string>) => fetch(`http://127.0.0.1:${port}/remise`, { method: "POST", body: corps, headers: entetes });
      expect((await appel({ authorization: "Instance ji1.a.b" })).status).toBe(403);
      expect((await appel({ "x-axion-jeton-instance": "ji1.vieux.b" })).status).toBe(403);
      expect((await appel({ authorization: "Bearer ji1.c.d" })).status).toBe(403);
      expect(vus).toEqual(["ji1.a.b"]); // seul l'en-tête Authorization: Instance est lu ; les autres arrivent vides ou ne passent pas
    } finally {
      await new Promise((ok) => serveur.close(ok));
    }
  });
});
