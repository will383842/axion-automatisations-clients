import { randomBytes, randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { EN_TETES, signer } from "../../../../packages/contrats/src/commun/signature.js";
import { brancherErreurs } from "../plugins/erreurs.js";
import { enregistrerCanal, type Memoire } from "./verifier-entrant.js";
import type { CleEchange } from "../coffre/cles-echanges.js";

// Clés de test générées au lancement : jamais écrites, jamais affichées.
const MAINTENANT = 1_800_000_000;
const cle = (kid: string): CleEchange => ({ kid, secret: randomBytes(32) });
const HUB = cle("rec-hub-1");
const CRM = cle("rec-crm-1");
const EMISSION_HUB = cle("emi-hub-1");

function memoire(): Memoire & { cles: Set<string> } {
  const cles = new Set<string>();
  return { cles, async set(k) { if (cles.has(k)) return null; cles.add(k); return "OK"; } };
}

function monter(options: { actif?: boolean; memoire?: Memoire; acceptees?: Record<string, CleEchange[]>; lignes?: unknown[] } = {}) {
  const serveur = Fastify({ genReqId: () => randomUUID() });
  brancherErreurs(serveur);
  const acceptees = options.acceptees ?? { "c2/reception": [HUB], "c3/reception": [CRM] };
  const traites: unknown[] = [];
  const deps = {
    cles: { async clesAcceptees(c: string, s: string) { return acceptees[`${c}/${s}`] ?? []; } },
    memoire: options.memoire ?? memoire(),
    actif: () => options.actif ?? true,
    journal: { info: (o: object) => void options.lignes?.push(o) },
    maintenant: () => MAINTENANT,
  };
  const routes = (s: FastifyInstance) => {
    s.post("/ecrire", async (r) => { traites.push(r.body); return { ok: true, corps: r.body }; });
    s.post("/faits", async (r) => { traites.push(r.body); return { ok: true }; });
    s.get("/lire", async () => ({ ok: true }));
  };
  enregistrerCanal(serveur, "hub", deps, routes);
  enregistrerCanal(serveur, "crm", deps, routes);
  return { serveur, traites };
}

function requete(chemin: string, o: { methode?: string; corps?: string; cle?: CleEchange; kid?: string; horodatage?: number | string; idem?: string | null; signature?: string } = {}) {
  const methode = o.methode ?? "POST";
  const corps = o.corps ?? '{"a":1,"b":2}';
  const k = o.cle ?? HUB;
  const h = String(o.horodatage ?? MAINTENANT);
  const entetes: Record<string, string> = {
    "content-type": "application/json",
    [EN_TETES.cle]: o.kid ?? k.kid,
    [EN_TETES.horodatage]: h,
    [EN_TETES.signature]: o.signature ?? signer(k.secret.toString("base64"), h, methode, chemin, corps),
  };
  if (o.idem !== null) entetes["idempotency-key"] = o.idem ?? "3f2b8c1e-5a4d-4e6f-9b7a-1c2d3e4f5a6b";
  return { method: methode as "POST", url: chemin, headers: entetes, ...(methode === "GET" ? {} : { payload: corps }) };
}
const code = (r: { json: () => { erreur: { code: string } } }) => r.json().erreur.code;

describe("vérification des requêtes entrantes", () => {
  it("[A-345] une requête bien signée passe, avec le corps analysé", async () => {
    const { serveur } = monter();
    const r = await serveur.inject(requete("/api/hub/v1/ecrire"));
    expect(r.statusCode).toBe(200);
    expect(r.json().corps).toEqual({ a: 1, b: 2 });
  });

  it("[A-345] une signature de plus de 5 minutes est refusée en horodatage_perime", async () => {
    const { serveur } = monter();
    for (const ecart of [-301, 301]) {
      const r = await serveur.inject(requete("/api/hub/v1/ecrire", { horodatage: MAINTENANT + ecart }));
      expect([r.statusCode, code(r)]).toEqual([401, "horodatage_perime"]);
    }
    expect((await serveur.inject(requete("/api/hub/v1/ecrire", { horodatage: MAINTENANT - 300 }))).statusCode).toBe(200);
  });

  it("[A-345] un horodatage de 9 ou 11 chiffres, avec espace, signe ou retour à la ligne est refusé", async () => {
    const { serveur } = monter();
    for (const h of [String(MAINTENANT).slice(1), `${MAINTENANT}0`, ` ${MAINTENANT}`, `+${MAINTENANT}`, `${MAINTENANT}\n`]) {
      const r = await serveur.inject(requete("/api/hub/v1/ecrire", { horodatage: h }));
      expect(r.statusCode, h).toBe(401);
    }
  });

  it("[A-345] une requête déjà vue est refusée en rejeu", async () => {
    const { serveur } = monter();
    const q = requete("/api/hub/v1/ecrire");
    expect((await serveur.inject(q)).statusCode).toBe(200);
    const r = await serveur.inject(q);
    expect([r.statusCode, code(r)]).toEqual([401, "rejeu"]);
  });

  it("[A-345] @isolation un corps rejoué vers une autre route est refusé", async () => {
    const { serveur, traites } = monter();
    const q = requete("/api/hub/v1/ecrire");
    await serveur.inject(q);
    for (const autre of ["/api/hub/v1/faits", "/api/crm/v1/ecrire"]) {
      const r = await serveur.inject({ ...q, url: autre });
      expect([r.statusCode, code(r)]).toEqual([401, "signature_invalide"]);
    }
    expect(traites).toHaveLength(1);
  });

  it("[A-345] la méthode et la requête font partie de la signature", async () => {
    const { serveur } = monter();
    const q = requete("/api/hub/v1/lire?x=1", { methode: "GET", corps: "" });
    expect((await serveur.inject({ ...q, method: "GET" })).statusCode).toBe(200);
    const autre = requete("/api/hub/v1/lire?x=1", { methode: "GET", corps: "" });
    expect((await serveur.inject({ ...autre, url: "/api/hub/v1/lire?x=2" })).statusCode).toBe(401);
    expect((await serveur.inject({ ...requete("/api/hub/v1/ecrire", { methode: "PUT" }), method: "POST" })).statusCode).toBe(401);
  });

  it("[A-345] le corps brut est signé : un octet de plus ou un JSON réordonné est refusé", async () => {
    const { serveur, traites } = monter();
    const base = requete("/api/hub/v1/ecrire");
    for (const corps of ['{"a":1,"b":2} ', '{"b":2,"a":1}', '{"a":1,"b":3}']) {
      const r = await serveur.inject({ ...base, payload: corps });
      expect([r.statusCode, code(r)]).toEqual([401, "signature_invalide"]);
    }
    expect(traites).toHaveLength(0);
  });

  it("[A-345] un corps non signé et invalide est refusé avant toute analyse JSON", async () => {
    const { serveur } = monter();
    const r = await serveur.inject({ method: "POST", url: "/api/hub/v1/ecrire", headers: { "content-type": "application/json" }, payload: "{pas du json" });
    expect([r.statusCode, code(r)]).toEqual([401, "signature_invalide"]);
  });

  it("[C-510] la clé du sens console vers Hub ne vérifie pas une requête du Hub vers la console", async () => {
    const { serveur } = monter();
    const r = await serveur.inject(requete("/api/hub/v1/ecrire", { cle: EMISSION_HUB }));
    expect([r.statusCode, code(r)]).toEqual([401, "signature_invalide"]);
    const avecKidReception = await serveur.inject(requete("/api/hub/v1/ecrire", { cle: EMISSION_HUB, kid: HUB.kid }));
    expect(code(avecKidReception)).toBe("signature_invalide");
  });

  it("[C-510] pendant le chevauchement, les deux clés actives sont acceptées ; une clé retirée est refusée", async () => {
    const ancienne = cle("rec-hub-0");
    const retiree = cle("rec-hub-retiree");
    const { serveur } = monter({ acceptees: { "c2/reception": [HUB, ancienne] } });
    expect((await serveur.inject(requete("/api/hub/v1/ecrire", { cle: HUB, idem: randomUUID() }))).statusCode).toBe(200);
    expect((await serveur.inject(requete("/api/hub/v1/ecrire", { cle: ancienne }))).statusCode).toBe(200);
    const r = await serveur.inject(requete("/api/hub/v1/ecrire", { cle: retiree }));
    expect([r.statusCode, code(r)]).toEqual([401, "signature_invalide"]);
    const sansPrefixe = requete("/api/hub/v1/ecrire", { cle: HUB, signature: signer(HUB.secret.toString("base64"), String(MAINTENANT), "POST", "/api/hub/v1/ecrire", '{"a":1,"b":2}').slice(3) });
    expect((await serveur.inject(sansPrefixe)).statusCode).toBe(401);
  });

  it("[C-510] porte fermée : 503 porte_fermee et rien n'est traité", async () => {
    const m = memoire();
    const { serveur, traites } = monter({ actif: false, memoire: m });
    const r = await serveur.inject(requete("/api/hub/v1/ecrire"));
    expect([r.statusCode, code(r)]).toEqual([503, "porte_fermee"]);
    expect(traites).toHaveLength(0);
    expect(m.cles.size).toBe(0);
  });

  it("[A-345] une écriture sans Idempotency-Key est refusée, sauf les faits du Hub", async () => {
    const { serveur } = monter();
    const r = await serveur.inject(requete("/api/hub/v1/ecrire", { idem: null }));
    expect([r.statusCode, code(r)]).toEqual([400, "schema_invalide"]);
    expect((await serveur.inject(requete("/api/hub/v1/ecrire", { idem: "pas-un-uuid", corps: '{"a":2}' }))).statusCode).toBe(400);
    expect((await serveur.inject(requete("/api/hub/v1/faits", { idem: null, corps: '{"a":3}' }))).statusCode).toBe(200);
    expect((await serveur.inject(requete("/api/crm/v1/faits", { cle: CRM, idem: null }))).statusCode).toBe(400);
  });

  it("[A-345] un Valkey défaillant refuse la requête en 503 sans l'accepter", async () => {
    const hs: Memoire = { set: async () => { throw new Error("connexion perdue"); } };
    const { serveur, traites } = monter({ memoire: hs });
    const r = await serveur.inject(requete("/api/hub/v1/ecrire"));
    expect([r.statusCode, code(r)]).toEqual([503, "porte_fermee"]);
    expect(traites).toHaveLength(0);
  });

  it("[A-345] un Valkey qui ne répond pas est refusé en 503 dans le délai", async () => {
    const bloque: Memoire = { set: () => new Promise(() => undefined) };
    const { serveur } = monter({ memoire: bloque });
    const debut = Date.now();
    const r = await serveur.inject(requete("/api/hub/v1/ecrire"));
    expect(r.statusCode).toBe(503);
    expect(Date.now() - debut).toBeLessThan(4000);
  });

  it("[A-345] une signature fausse n'occupe pas l'anti-rejeu", async () => {
    const m = memoire();
    const { serveur } = monter({ memoire: m });
    await serveur.inject(requete("/api/hub/v1/ecrire", { cle: EMISSION_HUB, kid: HUB.kid }));
    expect(m.cles.size).toBe(0);
  });

  it("[C-344] chaque passage sur un canal est journalisé sans corps ni signature", async () => {
    const lignes: unknown[] = [];
    const { serveur } = monter({ lignes });
    const q = requete("/api/hub/v1/ecrire?jeton=abc", { corps: '{"secret_metier":"valeur-sensible"}' });
    await serveur.inject(q);
    await serveur.inject(q);
    await serveur.inject({ ...q, headers: { ...q.headers, [EN_TETES.signature]: "v1=" + "0".repeat(64) } });
    const texte = JSON.stringify(lignes);
    expect(lignes).toHaveLength(3);
    expect(lignes.map((l) => (l as { resultat: string }).resultat)).toEqual(["ok", "rejeu", "signature_invalide"]);
    expect(lignes[0]).toMatchObject({ canal: "c2", sens: "entrant", route: "/api/hub/v1/ecrire", cle: HUB.kid, horodatage: String(MAINTENANT) });
    expect(typeof (lignes[0] as { id_trace: unknown }).id_trace).toBe("string");
    expect(texte).not.toMatch(/valeur-sensible|v1=|jeton=abc/);
    expect(texte).not.toContain(HUB.secret.toString("base64"));
  });
});
