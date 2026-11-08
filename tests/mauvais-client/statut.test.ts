import { createHmac } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { brancherErreurs } from "../../apps/api/src/plugins/erreurs.js";
import { routeStatut } from "../../apps/api/src/supervision/statut/routes.js";
import { routeSonde } from "../../apps/api/src/supervision/statut/sonde.js";
import { fastifyVide } from "../../scripts/liste-routes.js";

// Page d'état et sonde (T5-12b) : une session de client, l'absence de session et un client « absent » reçoivent la MÊME réponse 403 sur les routes de gestion (C-536),
// et AUCUN service n'est appelé. Les deux routes publiques ne lisent aucune donnée de client : la page ne porte que des composants génériques, la sonde exige une signature.
const MAINTENANT = Date.parse("2026-11-08T10:00:00Z");
const CLE = Buffer.from("cle-de-sonde-pour-essai-seulement");
const SESSIONS: Record<string, string> = { "sid-equipe": "dirigeant" };
let appels = 0;
let incidentsOuverts = 0;
let appli: ReturnType<typeof fastifyVide>;

beforeAll(async () => {
  appli = fastifyVide();
  brancherErreurs(appli);
  const compte = <T>(v: T): T => { appels++; return v; };
  routeStatut(appli, {
    ouvert: () => true,
    droits: {
      membre: async (requete: { headers: Record<string, unknown> }) => {
        const sid = /(?:^|;\s*)sid=([^;]+)/.exec(String(requete.headers["cookie"] ?? ""))?.[1] ?? "";
        const role = Object.hasOwn(SESSIONS, sid) ? SESSIONS[sid] : undefined;
        return role ? { sujet: "membre-1", role, actif: true, portee: { clients: [], automatisations: [] } } : undefined;
      },
      absenceOuverte: async () => false,
      tracer: async () => undefined,
    } as never,
    etatsBriques: async () => compte({ api: "haut" as const }),
    incidents: async () => compte([]),
    depot: { lire: async () => compte(null), ecrire: async () => { appels++; } },
    maintenant: () => MAINTENANT,
  });
  routeSonde(appli, {
    ouvert: () => true,
    cles: async () => compte([{ secret: CLE }]),
    ouvrirIncident: async () => { incidentsOuverts++; return { id: "inc-1", nouveau: true }; },
    maintenant: () => MAINTENANT,
  });
  await appli.ready();
});

async function jouer(methode: "GET" | "PUT", url: string, sid?: string) {
  const avant = appels;
  const r = await appli.inject({ method: methode, url, headers: sid ? { cookie: `sid=${sid}` } : {}, ...(methode === "PUT" ? { payload: { type: "maintenance", texte: "Maintenance ce soir." } } : {}) });
  const corps = (r.body ? r.json() : {}) as { erreur?: { id_trace?: string } };
  if (corps.erreur) delete corps.erreur.id_trace;
  return { statut: r.statusCode, corps, appels: appels - avant };
}
const REFUS = { statut: 403, appels: 0, corps: { erreur: { code: "action_interdite", message: "Action non permise." } } };
async function verifierGestion(methode: "GET" | "PUT") {
  const url = "/api/console/v1/statut";
  const client = await jouer(methode, url, "sid-client-a");
  const autreClient = await jouer(methode, url, "sid-client-b");
  const sansSession = await jouer(methode, url);
  expect(client).toEqual(autreClient);
  expect(sansSession).toEqual(client);
  expect((await jouer(methode, url, "sid-equipe")).statut).toBe(200); // témoin : le dirigeant passe le contrôle
  return client;
}

describe("mauvais client : page d'état et sonde", () => {
  it("[C-536] @isolation GET /api/console/v1/statut", async () => expect(await verifierGestion("GET")).toEqual(REFUS));
  it("[C-536] @isolation PUT /api/console/v1/statut", async () => expect(await verifierGestion("PUT")).toEqual(REFUS));
  it("[C-536] @isolation GET /api/public/v1/statut", async () => {
    // Publique : la réponse est la même pour tous (aucune session lue) et ne contient aucun identifiant de client.
    const a = await jouer("GET", "/api/public/v1/statut", "sid-client-a");
    const b = await jouer("GET", "/api/public/v1/statut", "sid-client-b");
    const anonyme = await jouer("GET", "/api/public/v1/statut");
    expect(a).toEqual(b);
    expect(anonyme).toEqual(a);
    expect(a.statut).toBe(200);
    expect(JSON.stringify(a.corps)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
  });
  it("[C-536] @isolation POST /api/public/v1/sonde", async () => {
    // Publique mais signée : sans signature valide, la même réponse 401 pour tous, et aucun incident n'est ouvert.
    const corps = JSON.stringify({ etat: "injoignable" });
    const h = String(Math.floor(MAINTENANT / 1000));
    const faux = createHmac("sha256", Buffer.from("autre")).update(`${h}.${corps}`).digest("hex");
    const rep = [];
    for (const en of [{}, { cookie: "sid=sid-client-a" }, { "x-axion-horodatage": h, "x-axion-signature": faux }]) {
      const r = await appli.inject({ method: "POST", url: "/api/public/v1/sonde", payload: corps, headers: { "content-type": "application/json", ...en } });
      rep.push(r.statusCode);
    }
    expect(rep).toEqual([401, 401, 401]);
    expect(incidentsOuverts).toBe(0); // aucun incident ouvert sans signature valide
  });
});
