import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { creerJournal } from "./journal.js";
import { creerRegistreJetons } from "./jetons.js";
import { creerServeur, type PortsServeur } from "./serveur.js";
import type { Planifier } from "./remise.js";

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

  // Horloge factice : les échéances ne tombent que quand l'essai le décide.
  const horloge = () => {
    const taches: Array<() => void> = [];
    const planifier: Planifier = (f) => { taches.push(f); return () => { const i = taches.indexOf(f); if (i >= 0) taches.splice(i, 1); }; };
    return { planifier, echeance: () => { for (const f of taches.splice(0)) f(); }, enAttente: () => taches.length };
  };
  const portsDe = (sur: Partial<PortsServeur> = {}): PortsServeur => ({
    verifierSignature: async () => "cellule-1",
    verifierJetonInstance: async () => true,
    executionEnCours: async () => true,
    connexion: async () => undefined,
    lireCoffre: async () => ({}),
    jetons: creerRegistreJetons(),
    journal: creerJournal(() => undefined),
    maintenant: () => Date.now(),
    dureeExecutionMs: 1000,
    ...sur,
  });
  const ecouter = async (s: ReturnType<typeof creerServeur>) => { await new Promise<void>((ok) => s.listen(0, "127.0.0.1", ok)); return (s.address() as AddressInfo).port; };

  it("[C-014] un flux de plus de 4 Ko est coupé (413) sans être lu en entier ni soumis à la signature", async () => {
    let signatures = 0;
    const serveur = creerServeur(portsDe({ verifierSignature: async () => { signatures += 1; return "cellule-1"; } }));
    const port = await ecouter(serveur);
    try {
      // La requête n'est JAMAIS terminée par le client : seule une coupure par le serveur peut produire la réponse.
      const statut = await new Promise<number>((ok, ko) => {
        const req = request({ host: "127.0.0.1", port, method: "POST", path: "/remise", headers: { "Content-Type": "application/json" } }, (res) => { res.resume(); ok(res.statusCode ?? 0); });
        req.on("error", (e) => { if ((e as NodeJS.ErrnoException).code !== "ECONNRESET" && (e as NodeJS.ErrnoException).code !== "EPIPE") ko(e); });
        for (let i = 0; i < 5; i += 1) req.write(Buffer.alloc(1024, 0x61)); // 5 Ko, sans req.end()
        setTimeout(() => { req.destroy(); ko(new Error("le serveur attend la fin du flux")); }, 3000).unref();
      });
      expect(statut).toBe(413);
      expect(signatures).toBe(0);
    } finally {
      serveur.closeAllConnections();
      await new Promise((ok) => serveur.close(ok));
    }
  });

  it("[C-014] une signature qui ne répond pas est refusée après le délai maximal", async () => {
    const h = horloge();
    const serveur = creerServeur(portsDe({ verifierSignature: () => new Promise<string | null>(() => undefined) }), { delaiMs: 2000, planifier: h.planifier });
    const port = await ecouter(serveur);
    try {
      const reponse = fetch(`http://127.0.0.1:${port}/remise`, { method: "POST", body: "{}", headers: { authorization: "Instance ji1.a.b" } });
      await vi.waitFor(() => expect(h.enAttente()).toBeGreaterThan(0));
      h.echeance();
      expect((await reponse).status).toBe(403);
    } finally {
      serveur.closeAllConnections();
      await new Promise((ok) => serveur.close(ok));
    }
  });

  it("[C-014] un coffre qui ne répond pas rend une erreur propre (503) après le délai, sans valeur", async () => {
    const h = horloge();
    let signal: AbortSignal | undefined;
    const serveur = creerServeur(portsDe({
      connexion: async (instanceId, connexionId) => ({ instanceId, connexionId, tenantId: "11111111-1111-4111-8111-111111111111", celluleCode: "cellule-1", famille: "oauth", referenceCoffre: "bao:clients/11111111-1111-4111-8111-111111111111/d0d0d0d0-0000-4000-8000-000000000001", portees: [], porteesModule: [] }),
      lireCoffre: (_chemin, s) => { signal = s; return new Promise<Record<string, unknown>>(() => undefined); },
      planifier: h.planifier,
      delaiCoffreMs: 3000,
    }), { delaiMs: 2000, planifier: h.planifier });
    const port = await ecouter(serveur);
    try {
      const reponse = fetch(`http://127.0.0.1:${port}/remise`, { method: "POST", body: JSON.stringify({ instanceId: INSTANCE, executionId: EXEC, connexionId: CONN }), headers: { authorization: "Instance ji1.a.b" } });
      await vi.waitFor(() => expect(signal).toBeDefined());
      h.echeance();
      const r = await reponse;
      expect(r.status).toBe(503);
      expect(await r.json()).toEqual({ code: "coffre_indisponible" });
      expect(signal?.aborted).toBe(true); // l'appel au coffre est abandonné, pas laissé en vol
    } finally {
      serveur.closeAllConnections();
      await new Promise((ok) => serveur.close(ok));
    }
  });
});
