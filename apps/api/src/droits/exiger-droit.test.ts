import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { brancherErreurs } from "../plugins/erreurs.js";
import { exigerDroit, type DepsDroits, type MembreDroits, type TraceRefus } from "./exiger-droit.js";
import { dansPortee, filtrerParPortee } from "./portee.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const limite = (role: MembreDroits["role"] = "second_administrateur", clients: string[] = [A]): MembreDroits => ({ sujet: "m1", role, actif: true, portee: { clients, automatisations: [] } });

function appli(etat: { membre?: MembreDroits | undefined; absence?: boolean }) {
  const traces: TraceRefus[] = [];
  const d: DepsDroits = {
    membre: async () => etat.membre,
    absenceOuverte: async () => etat.absence === true,
    tracer: async (e) => { traces.push(e); },
  };
  const s = Fastify();
  brancherErreurs(s);
  s.get("/liste", { preHandler: exigerDroit("lire", d, { globale: "essai : liste non filtrée" }) }, async () => ({ ok: true }));
  s.get("/c/:id", { preHandler: exigerDroit("lire", d, { client: (r) => (r.params as { id: string }).id }) }, async () => ({ ok: true }));
  s.post("/facture", { preHandler: exigerDroit("emettre_facture", d, { globale: "essai : action sans client" }) }, async () => ({ ok: true }));
  s.post("/violation", { preHandler: exigerDroit("envoyer_notification_violation", d, { globale: "essai : action sans client" }) }, async () => ({ ok: true }));
  return { s, traces };
}

describe("exigerDroit", () => {
  it("[LOT3-droits] chaque refus est tracé", async () => {
    const { s, traces } = appli({ membre: limite() });
    const r = await s.inject({ method: "POST", url: "/facture" });
    expect(r.statusCode).toBe(403);
    expect(r.json().erreur.code).toBe("action_interdite");
    expect(traces).toHaveLength(1);
    expect(traces[0]).toMatchObject({ action: "emettre_facture", sujet: "m1", motif: "droit_refuse" });
    expect(JSON.stringify(traces)).not.toContain("secret");
  });

  it("[LOT3-droits] sans membre actif connu, tout est refusé et tracé", async () => {
    for (const membre of [undefined, { ...limite(), actif: false }]) {
      const { s, traces } = appli({ membre });
      expect((await s.inject({ method: "GET", url: `/c/${A}` })).statusCode).toBe(403);
      expect(traces).toHaveLength(1);
    }
  });

  it("[B-126] @isolation un membre limité au client A reçoit 404 sur B", async () => {
    const { s, traces } = appli({ membre: limite() });
    expect((await s.inject({ method: "GET", url: `/c/${A}` })).statusCode).toBe(200);
    const r = await s.inject({ method: "GET", url: `/c/${B}` });
    expect(r.statusCode).toBe(404);
    expect(r.json().erreur.code).toBe("introuvable");
    expect(traces[0]).toMatchObject({ motif: "hors_portee" });
  });

  it("[B-126] une portée vide d'un second administrateur ne donne accès à rien, le dirigeant n'est pas limité", () => {
    expect(dansPortee(limite("second_administrateur", []), A)).toBe(false);
    expect(dansPortee(limite("dirigeant", []), A)).toBe(true);
    expect(filtrerParPortee(limite(), [A, B, "pas-un-id"])).toEqual([A]);
    expect(filtrerParPortee(limite("second_administrateur", []), [A])).toEqual([]);
  });

  it("[B-126] @isolation une route sans extracteur de client refuse un second administrateur limité ou à portée vide (échec fermé)", async () => {
    for (const clients of [[A], []]) {
      const { s, traces } = appli({ membre: limite("second_administrateur", clients) });
      const r = await s.inject({ method: "GET", url: "/liste" });
      expect(r.statusCode).toBe(404);
      expect(r.json().erreur.code).toBe("introuvable");
      expect(traces[0]).toMatchObject({ motif: "hors_portee" });
    }
    const { s } = appli({ membre: limite("dirigeant", []) });
    expect((await s.inject({ method: "GET", url: "/liste" })).statusCode).toBe(200);
  });

  it("[C-617] les droits suivent l'absence à chaque requête, sans cache", async () => {
    const etat: { membre?: MembreDroits | undefined; absence?: boolean } = { membre: limite(), absence: true };
    const { s } = appli(etat);
    expect((await s.inject({ method: "POST", url: "/violation" })).statusCode).toBe(200);
    etat.absence = false;
    expect((await s.inject({ method: "POST", url: "/violation" })).statusCode).toBe(403);
    etat.absence = true;
    etat.membre = limite("dirigeant");
    expect((await s.inject({ method: "POST", url: "/facture" })).statusCode).toBe(200);
    etat.membre = limite("second_administrateur");
    expect((await s.inject({ method: "POST", url: "/facture" })).statusCode).toBe(403);
  });

  it("[LOT3-droits] le crochet porte son action, lue par la garde", () => {
    const { s } = appli({});
    expect(s).toBeDefined();
    expect((exigerDroit("lire", {} as DepsDroits, { globale: "essai" }) as unknown as { action: string }).action).toBe("lire");
  });
});
