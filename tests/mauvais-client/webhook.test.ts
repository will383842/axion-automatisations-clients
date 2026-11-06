import { createHmac, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { creerWebhook } from "../../apps/api/src/executeur/webhooks.js";
import { routeWebhooks, type DepsWebhooks, type WebhookConnu } from "../../apps/api/src/routes/webhooks/entree.js";
import { fastifyVide } from "../../scripts/liste-routes.js";

// Webhook entrant (T4-24). Le « client » qui appelle est porteur d'un secret : le secret du webhook d'un AUTRE client est refusé (404 identique à un webhook inconnu)
// et aucun travail n'est déposé (C-536). Secrets générés au lancement, jamais écrits.
const TENANT_A = randomUUID();
const TENANT_B = randomUUID();
const CORPS = JSON.stringify({ objet: "demande de devis" });

function monter() {
  const coffre = new Map<string, string>();
  const base = new Map<string, WebhookConnu>();
  const travaux: string[] = [];
  const depot = { async inserer(w: WebhookConnu) { base.set(w.id, w); }, async lire(id: string) { return base.get(id) ?? null; } };
  const ranger = async (_t: string, secret: string) => { const ref = `bao:clients/ref-${coffre.size}`; coffre.set(ref, secret); return ref; };
  const deps: DepsWebhooks = {
    actif: () => true,
    depot,
    secret: async (ref) => coffre.get(ref)!,
    instance: async (instanceId) => ({ cellule: instanceId === "instance-a" ? "cellule-un" : "cellule-deux", etat: "active" }),
    memoire: { async set() { return "OK"; } },
    file: (nom) => ({ name: nom, async add() { travaux.push(nom); } }),
    sceller: async (_t, corps) => `scelle:${corps.length}`,
    debit: { parWebhook: 100, global: 1000, fenetreMs: 60_000 },
  };
  const serveur = fastifyVide();
  routeWebhooks(serveur, deps);
  return { serveur, depot, ranger, travaux };
}
const signe = (secret: string) => `sha256=${createHmac("sha256", secret).update(CORPS).digest("hex")}`;

describe("webhook entrant, mauvais client (T4-24)", () => {
  it("[C-536] @isolation POST /webhook/:id un webhook d'un autre client est refusé", async () => {
    const m = monter();
    const a = await creerWebhook({ tenantId: TENANT_A, instanceId: "instance-a", schema: { type: "hmac", entete: "x-signature" } }, { depot: m.depot, ranger: m.ranger });
    const b = await creerWebhook({ tenantId: TENANT_B, instanceId: "instance-b", schema: { type: "hmac", entete: "x-signature" } }, { depot: m.depot, ranger: m.ranger });
    const appeler = (id: string, secret: string) =>
      m.serveur.inject({ method: "POST", url: `/webhook/${id}`, headers: { "content-type": "application/json", "x-signature": signe(secret) }, payload: CORPS });
    const croise = await appeler(b.id, a.secret);
    const inconnu = await appeler("AAAAAAAAAAAAAAAAAAAAAA", a.secret);
    expect(croise.statusCode).toBe(404);
    expect(croise.body).toBe(inconnu.body);
    expect(m.travaux).toHaveLength(0);
    expect((await appeler(b.id, b.secret)).statusCode).toBe(202);
    expect(m.travaux).toEqual(["executions-cellule-deux"]);
  });
});
