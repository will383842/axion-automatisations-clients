import { createHmac, randomUUID } from "node:crypto";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { creerWebhook } from "../../executeur/webhooks.js";
import { routeWebhooks, webhooksOuverts, type DepsWebhooks, type WebhookConnu } from "./entree.js";

// Secrets générés au lancement, jamais écrits. Deux clients, deux cellules.
const TENANT_A = randomUUID();
const TENANT_B = randomUUID();
const CORPS = JSON.stringify({ objet: "demande de devis" });

function monter(o: { actif?: boolean; pause?: boolean; debit?: Partial<DepsWebhooks["debit"]>; echecDepot?: { reste: number } } = {}) {
  const coffre = new Map<string, string>();
  const base = new Map<string, WebhookConnu>();
  const travaux: { file: string; nom: string; donnees: Record<string, unknown>; jobId: string }[] = [];
  const vus = new Set<string>();
  const compteurs: string[] = [];
  const depot = { async inserer(w: WebhookConnu) { base.set(w.id, w); }, async lire(id: string) { return base.get(id) ?? null; } };
  const ranger = async (_tenant: string, secret: string) => { const ref = `bao:clients/ref-${coffre.size}`; coffre.set(ref, secret); return ref; };
  const deps: DepsWebhooks = {
    actif: () => o.actif ?? true,
    depot,
    secret: async (ref) => coffre.get(ref)!,
    instance: async (instanceId) => ({ cellule: instanceId === "instance-a" ? "cellule-un" : "cellule-deux", etat: o.pause ? "pause" : "active" }),
    memoire: { async set(cle: string) { if (vus.has(cle)) return null; vus.add(cle); return "OK"; }, async del(cle: string) { vus.delete(cle); } },
    file: (nom) => ({ name: nom, async add(type: string, donnees: unknown, opts?: { jobId?: string }) { if (o.echecDepot && o.echecDepot.reste-- > 0) throw new Error("valkey indisponible"); travaux.push({ file: nom, nom: type, donnees: donnees as Record<string, unknown>, jobId: opts?.jobId ?? "" }); } }),
    sceller: async (_tenant, corps) => `scelle:${corps.length}`,
    compter: (m) => compteurs.push(m),
    debit: { parWebhook: 100, global: 1000, fenetreMs: 60_000, ...o.debit },
  };
  const serveur = Fastify();
  routeWebhooks(serveur, deps);
  return { serveur, deps, depot, ranger, travaux, compteurs };
}
async function creer(m: ReturnType<typeof monter>, tenantId: string, instanceId: string, schema: WebhookConnu["schema"] = { type: "hmac", entete: "x-signature" }) {
  return creerWebhook({ tenantId, instanceId, schema }, { depot: m.depot, ranger: m.ranger });
}
const signe = (secret: string, corps = CORPS) => `sha256=${createHmac("sha256", secret).update(corps).digest("hex")}`;
const appeler = (m: ReturnType<typeof monter>, id: string, entetes: Record<string, string>, corps: string = CORPS) =>
  m.serveur.inject({ method: "POST", url: `/webhook/${id}`, headers: { "content-type": "application/json", ...entetes }, payload: corps });

describe("webhook entrant (T4-24)", () => {
  it("[A-292] un webhook signé déclenche une exécution de son instance", async () => {
    const m = monter();
    const w = await creer(m, TENANT_A, "instance-a");
    const r = await appeler(m, w.id, { "x-signature": signe(w.secret), "x-event-id": "evt-1" });
    expect(r.statusCode).toBe(202);
    expect(r.body).toBe("");
    expect(m.travaux).toHaveLength(1);
    expect(m.travaux[0]!.donnees["instanceId"]).toBe("instance-a");
    expect(m.travaux[0]!.donnees["tenantId"]).toBe(TENANT_A);
    expect(JSON.stringify(m.travaux[0]!.donnees)).not.toContain("demande de devis");
  });

  it("[A-292] le même appel reçu deux fois ne crée qu'un travail", async () => {
    const m = monter();
    const w = await creer(m, TENANT_A, "instance-a");
    const entetes = { "x-signature": signe(w.secret), "x-event-id": "evt-2" };
    expect((await appeler(m, w.id, entetes)).statusCode).toBe(202);
    expect((await appeler(m, w.id, entetes)).statusCode).toBe(202);
    expect(m.travaux).toHaveLength(1);
    // sans identifiant d'événement : empreinte du corps
    const autre = JSON.stringify({ objet: "autre demande" });
    const sans = { "x-signature": signe(w.secret, autre) };
    await appeler(m, w.id, sans, autre);
    await appeler(m, w.id, sans, autre);
    expect(m.travaux).toHaveLength(2);
  });

  it("[A-083] @isolation le travail part dans la file de la cellule de l'instance, jamais d'une autre", async () => {
    const m = monter();
    const a = await creer(m, TENANT_A, "instance-a");
    const b = await creer(m, TENANT_B, "instance-b");
    await appeler(m, a.id, { "x-signature": signe(a.secret), "x-event-id": "e" });
    await appeler(m, b.id, { "x-signature": signe(b.secret), "x-event-id": "e" });
    expect(m.travaux.map((t) => t.file)).toEqual(["executions-cellule-un", "executions-cellule-deux"]);
    expect(m.travaux[0]!.jobId).not.toBe(m.travaux[1]!.jobId);
  });

  it("[A-292] @isolation le secret du webhook de A ne déclenche pas le webhook de B", async () => {
    const m = monter();
    const a = await creer(m, TENANT_A, "instance-a");
    const b = await creer(m, TENANT_B, "instance-b", { type: "secret", entete: "x-webhook-secret" });
    expect((await appeler(m, b.id, { "x-webhook-secret": a.secret })).statusCode).toBe(404);
    expect((await appeler(m, b.id, { "x-signature": signe(a.secret) })).statusCode).toBe(404);
    expect((await appeler(m, b.id, { "x-webhook-secret": b.secret })).statusCode).toBe(202);
    expect(m.travaux).toHaveLength(1);
    expect(m.travaux[0]!.file).toBe("executions-cellule-deux");
  });

  it("[A-292] mauvaise signature, webhook inconnu et webhook révoqué donnent la même réponse", async () => {
    const m = monter();
    const w = await creer(m, TENANT_A, "instance-a");
    const r = await creer(m, TENANT_A, "instance-a");
    m.depot.inserer({ ...(await m.depot.lire(r.id))!, revoque: true });
    const mauvaise = await appeler(m, w.id, { "x-signature": signe("autre") });
    const inconnu = await appeler(m, "AAAAAAAAAAAAAAAAAAAAAA", { "x-signature": signe(w.secret) });
    const revoque = await appeler(m, r.id, { "x-signature": signe(r.secret) });
    for (const x of [inconnu, revoque]) {
      expect(x.statusCode).toBe(mauvaise.statusCode);
      expect(x.body).toBe(mauvaise.body);
    }
    expect(mauvaise.statusCode).toBe(404);
    expect(m.travaux).toHaveLength(0);
    expect([...m.compteurs].sort()).toEqual(["inconnu", "revoque", "signature"]);
  });

  it("[A-292] un appel signé rejoué avec un autre x-event-id ne crée pas de second travail", async () => {
    const m = monter();
    const w = await creer(m, TENANT_A, "instance-a");
    const signature = signe(w.secret);
    expect((await appeler(m, w.id, { "x-signature": signature, "x-event-id": "x1" })).statusCode).toBe(202);
    for (const id of ["x2", "x3", "x4"]) expect((await appeler(m, w.id, { "x-signature": signature, "x-event-id": id })).statusCode).toBe(202);
    expect((await appeler(m, w.id, { "x-signature": signature })).statusCode).toBe(202);
    expect(m.travaux).toHaveLength(1);
  });

  it("[A-292] des appels non authentifiés en masse ne bloquent pas le webhook signé d'un autre client", async () => {
    const m = monter({ debit: { global: 3, parWebhook: 3, refusParSource: 5 } });
    const a = await creer(m, TENANT_A, "instance-a");
    const b = await creer(m, TENANT_B, "instance-b");
    for (let i = 0; i < 30; i++) await appeler(m, "AAAAAAAAAAAAAAAAAAAAAA", { "x-signature": "sha256=00" });
    for (let i = 0; i < 30; i++) await appeler(m, a.id, { "x-signature": "sha256=00" });
    expect((await appeler(m, b.id, { "x-signature": signe(b.secret), "x-event-id": "b1" })).statusCode).toBe(202);
    // le webhook de A, qui a seulement reçu des appels refusés, accepte encore son émetteur légitime
    expect((await appeler(m, a.id, { "x-signature": signe(a.secret), "x-event-id": "a1" })).statusCode).toBe(202);
    expect(m.travaux).toHaveLength(2);
  });

  it("[A-292] au-delà du débit par webhook : 429, et un autre webhook passe encore", async () => {
    const m = monter({ debit: { parWebhook: 2 } });
    const a = await creer(m, TENANT_A, "instance-a");
    const b = await creer(m, TENANT_B, "instance-b");
    const statuts: number[] = [];
    for (const e of ["e1", "e2", "e3", "e4"]) statuts.push((await appeler(m, a.id, { "x-signature": signe(a.secret, e), "x-event-id": e }, e)).statusCode);
    expect(statuts).toEqual([202, 202, 429, 429]);
    expect((await appeler(m, b.id, { "x-signature": signe(b.secret), "x-event-id": "b1" })).statusCode).toBe(202);
  });

  it("[A-292] instance en pause : travail déposé, rien n'est exécuté", async () => {
    const m = monter({ pause: true });
    const w = await creer(m, TENANT_A, "instance-a");
    expect((await appeler(m, w.id, { "x-signature": signe(w.secret), "x-event-id": "p1" })).statusCode).toBe(202);
    expect(m.travaux).toHaveLength(1);
    expect(m.travaux[0]!.file).toBe("executions-cellule-un");
  });

  it("[A-292] après un échec du dépôt, le renvoi de l'émetteur crée le travail", async () => {
    const m = monter({ echecDepot: { reste: 1 } });
    const w = await creer(m, TENANT_A, "instance-a");
    const entetes = { "x-signature": signe(w.secret), "x-event-id": "r1" };
    expect((await appeler(m, w.id, entetes)).statusCode).toBe(503);
    expect(m.travaux).toHaveLength(0);
    expect((await appeler(m, w.id, entetes)).statusCode).toBe(202);
    expect(m.travaux).toHaveLength(1);
  });

  it("[A-292] webhook révoqué dont le secret est effacé du coffre répond 404 comme un inconnu", async () => {
    const m = monter();
    const r = await creer(m, TENANT_A, "instance-a");
    await m.depot.inserer({ ...(await m.depot.lire(r.id))!, revoque: true });
    m.deps.secret = async () => { throw new Error("secret effacé"); };
    const revoque = await appeler(m, r.id, { "x-signature": signe(r.secret) });
    const inconnu = await appeler(m, "AAAAAAAAAAAAAAAAAAAAAA", { "x-signature": signe(r.secret) });
    expect(revoque.statusCode).toBe(404);
    expect(revoque.statusCode).toBe(inconnu.statusCode);
    expect(revoque.body).toBe(inconnu.body);
  });

  it("[A-292] corps de plus de 1 Mo refusé avant lecture complète", async () => {
    const m = monter();
    const w = await creer(m, TENANT_A, "instance-a");
    const gros = "x".repeat(1024 * 1024 + 1);
    const r = await appeler(m, w.id, { "x-signature": signe(w.secret, gros) }, gros);
    expect(r.statusCode).toBe(413);
    expect(m.travaux).toHaveLength(0);
  });

  it("[A-292] la porte reste fermée tant que WEBHOOKS_OUVERTS n'est pas ouvert", async () => {
    expect(webhooksOuverts({})).toBe(false);
    expect(webhooksOuverts({ WEBHOOKS_OUVERTS: "1" })).toBe(true);
    const m = monter({ actif: false });
    const w = await creer(m, TENANT_A, "instance-a");
    expect((await appeler(m, w.id, { "x-signature": signe(w.secret) })).statusCode).toBe(503);
    expect(m.travaux).toHaveLength(0);
  });

  it("[A-292] l'identifiant fait 128 bits et le secret ne va jamais en base", async () => {
    const m = monter();
    const w = await creer(m, TENANT_A, "instance-a");
    expect(w.id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(JSON.stringify(await m.depot.lire(w.id))).not.toContain(w.secret);
  });
});
