import { randomBytes, randomUUID } from "node:crypto";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { EN_TETES, signer } from "../../../../../packages/contrats/src/commun/signature.js";
import type { CleEchange } from "../../coffre/cles-echanges.js";
import { idExecution, type DepotExecutions } from "../../executeur/ranger-evenements.js";
import type { InstanceResolue } from "../../executeur/portees.js";
import { brancherErreurs } from "../../plugins/erreurs.js";
import { routeExecuteur, type DepsExecuteur } from "./index.js";

const MAINTENANT = 1_800_000_000;
const CHEMIN = "/api/executeur/v1/evenements";
const X = randomUUID(); // instance de la cellule un
const Y = randomUUID(); // instance de la cellule deux
const TENANT_X = randomUUID();
const TENANT_Y = randomUUID();
const A = "2026-11-06T10:00:00.000Z";

function monter(o: { actif?: boolean } = {}) {
  const secrets = new Map<string, Buffer>([["c4-cellule-un", randomBytes(32)], ["c4-cellule-deux", randomBytes(32)]]);
  const vus = new Set<string>();
  const lignes = new Map<string, { tenant: string; instance: string; statut: string; duree?: number; elements?: number; jetons?: number; cout?: number; code?: string }>();
  const signaux: string[] = [];
  const incidents: string[] = [];
  const depot: DepotExecutions = {
    async debut(tenant, instance, id) { if (!lignes.has(id)) lignes.set(id, { tenant, instance, statut: "en_cours" }); },
    async fin(tenant, instance, id, v) { await this.debut(tenant, instance, id); const l = lignes.get(id)!; if (l.statut === "en_cours") Object.assign(l, { statut: "reussie", duree: v.dureeMs, elements: v.elements, jetons: v.jetons, cout: v.coutIaMicroCentimes }); },
    async erreur(tenant, instance, id, code) { await this.debut(tenant, instance, id); const l = lignes.get(id)!; if (l.statut === "en_cours") Object.assign(l, { statut: "echec", code }); },
    async signalDeVie(cellule) { signaux.push(cellule); },
  };
  const instances: Record<string, InstanceResolue> = {
    [X]: { tenantId: TENANT_X, celluleCode: "cellule-un", etat: "active", arretEnvois: false, version: 1 },
    [Y]: { tenantId: TENANT_Y, celluleCode: "cellule-deux", etat: "active", arretEnvois: false, version: 1 },
  };
  const deps: DepsExecuteur = {
    actif: () => o.actif ?? true,
    cles: {
      async clesAcceptees(canal: string) { return [{ kid: "k1", secret: secrets.get(canal)! } as CleEchange]; },
    },
    memoire: { async set(k) { if (vus.has(k)) return null; vus.add(k); return "OK"; } },
    depot: { async resoudre(id) { return instances[id] ?? null; }, async configuration() { return null; } },
    evenements: { depot, compter: (nom) => void incidents.push(nom) },
    maintenant: () => MAINTENANT,
  };
  const serveur = Fastify({ genReqId: () => randomUUID() });
  brancherErreurs(serveur);
  routeExecuteur(serveur, deps);
  const poster = (corps: unknown, p: { cellule?: string; brut?: string; cleSecret?: Buffer; cle?: string; decalage?: number } = {}) => {
    const cellule = p.cellule ?? "cellule-un";
    const texte = p.brut ?? JSON.stringify(corps);
    const h = String(MAINTENANT + (p.decalage ?? 0));
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "idempotency-key": p.cle ?? randomUUID(),
      [EN_TETES.cle]: `c4:${cellule}:k1`,
      [EN_TETES.horodatage]: h,
      [EN_TETES.signature]: signer((p.cleSecret ?? secrets.get(`c4-${cellule}`)!).toString("base64"), h, "POST", CHEMIN, texte),
    };
    return serveur.inject({ method: "POST", url: CHEMIN, headers, payload: texte });
  };
  return { poster, lignes, signaux, incidents, secrets };
}
const debut = (instanceId: string, executionId: string) => ({ type: "debut", instanceId, executionId, a: A });
const fin = (instanceId: string, executionId: string, extra: object = {}) => ({ type: "fin", instanceId, executionId, dureeMs: 1200, elements: 4, minutesGagnees: 20, jetons: 300, coutIaMicroCentimes: 15, ...extra });

describe("réception des événements d'exécution", () => {
  it("[A-343] un paquet debut puis fin range une exécution terminée sous le client de l'instance", async () => {
    const m = monter();
    const r = await m.poster({ evenements: [debut(X, "exec-1"), fin(X, "exec-1")] });
    expect(r.statusCode).toBe(202);
    const l = m.lignes.get(idExecution(X, "exec-1"))!;
    expect(l).toMatchObject({ tenant: TENANT_X, instance: X, statut: "reussie", duree: 1200, elements: 4, jetons: 300, cout: 15 });
  });

  it("[A-343] debut puis erreur range un échec avec son code", async () => {
    const m = monter();
    await m.poster({ evenements: [debut(X, "exec-2"), { type: "erreur", instanceId: X, executionId: "exec-2", classe: "definitive", code: "reglage_manquant" }] });
    expect(m.lignes.get(idExecution(X, "exec-2"))).toMatchObject({ statut: "echec", code: "reglage_manquant" });
  });

  it("[A-343] le même paquet rejoué ne crée aucune ligne de plus et rend la même réponse", async () => {
    const m = monter();
    const paquet = { evenements: [debut(X, "exec-3"), fin(X, "exec-3")] };
    const cle = randomUUID();
    const un = await m.poster(paquet, { cle });
    const deux = await m.poster(paquet, { cle, decalage: 1 }); // nouvel essai re-signé
    expect(m.lignes.size).toBe(1);
    expect([un.statusCode, deux.statusCode]).toEqual([202, 202]);
    expect(deux.body).toBe(un.body);
    expect((await m.poster(paquet, { cle, decalage: 1 })).statusCode).toBe(401); // même signature : rejeu refusé
  });

  it("[A-346] un événement avec un champ « objet » est refusé par la console", async () => {
    const m = monter();
    const r = await m.poster({ evenements: [{ ...debut(X, "exec-4"), objet: "Devis Dupont" }] });
    expect(r.statusCode).toBe(400);
    expect(m.lignes.size).toBe(0);
  });

  it("[A-346] @isolation un paquet de la cellule 1 qui contient une instance de la cellule 2 est refusé en entier", async () => {
    const m = monter();
    const r = await m.poster({ evenements: [debut(X, "exec-5"), debut(Y, "exec-6")] });
    expect(r.statusCode).toBe(403);
    expect(r.json().erreur.code).toBe("action_interdite");
    expect(m.lignes.size).toBe(0); // rien du paquet n'est rangé, pas même l'instance de la cellule 1
    expect(m.incidents).toEqual(["paquet_hors_cellule"]);
  });

  it("[A-346] @isolation une instance inconnue refuse aussi le paquet entier", async () => {
    const m = monter();
    const r = await m.poster({ evenements: [debut(X, "exec-7"), debut(randomUUID(), "exec-8")] });
    expect(r.statusCode).toBe(403);
    expect(m.lignes.size).toBe(0);
  });

  it("[A-346] une signature fausse, la clé d'une autre cellule ou l'absence de signature : 401", async () => {
    const m = monter();
    expect((await m.poster({ evenements: [debut(X, "e")] }, { cleSecret: m.secrets.get("c4-cellule-deux")! })).statusCode).toBe(401);
    expect((await m.poster({ evenements: [debut(X, "e")] }, { cellule: "cellule-un", cleSecret: randomBytes(32) })).statusCode).toBe(401);
  });

  it("[A-346] corps de plus de 1 Mo refusé avant toute analyse, plus de 500 événements refusés", async () => {
    const m = monter();
    const gros = await m.poster(null, { brut: JSON.stringify({ evenements: [], bourrage: "x".repeat(1_100_000) }) });
    expect(gros.statusCode).toBe(413);
    const trop = await m.poster({ evenements: Array.from({ length: 501 }, (_, i) => debut(X, `e${i}`)) });
    expect(trop.statusCode).toBe(400);
    expect(m.lignes.size).toBe(0);
  });

  it("[A-346] Idempotency-Key obligatoire", async () => {
    const m = monter();
    const r = await m.poster({ evenements: [debut(X, "e")] }, { cle: "pas-un-uuid" });
    expect(r.statusCode).toBe(400);
  });

  it("[A-344] un signal de vie met à jour la dernière nouvelle de la cellule signataire", async () => {
    const m = monter();
    const r = await m.poster({ evenements: [{ type: "signal_de_vie", instanceId: X, celluleId: "cellule-un", a: A }] });
    expect(r.statusCode).toBe(202);
    expect(m.signaux).toEqual(["cellule-un"]);
  });

  it("[A-346] un signal de vie forgé au nom d'une autre cellule refuse le paquet", async () => {
    const m = monter();
    const r = await m.poster({ evenements: [{ type: "signal_de_vie", instanceId: X, celluleId: "cellule-deux", a: A }] });
    expect(r.statusCode).toBe(403);
    expect(m.signaux).toEqual([]);
  });

  it("[A-346] une durée ou des éléments hors des bornes de la base refusent le paquet", async () => {
    const m = monter();
    const r = await m.poster({ evenements: [fin(X, "exec-9", { elements: 2_147_483_648 })] });
    expect(r.statusCode).toBe(422);
    expect(m.lignes.size).toBe(0);
  });
});
