import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { exigerReauthentification } from "../../auth/exiger-reauthentification.js";
import { exigerJeton } from "../../auth/oidc.js";
import type { DepsDroits, MembreDroits, TraceRefus } from "../../droits/exiger-droit.js";
import { ErreurApi, brancherErreurs } from "../../plugins/erreurs.js";
import { routeMembres, type DepsRoutesMembres } from "./membres.js";

// Routes des membres de l'équipe (T3-07c). Le jeton est un faux vérificateur : seule la chaîne de crochets est prouvée, dans l'ordre porte, jeton, réauthentification, droit.
const MAINTENANT = 1_800_000_000_000;
const ID = "44444444-4444-4444-8444-444444444444";
const dirigeant: MembreDroits = { sujet: "kc-dirigeant-1", role: "dirigeant", actif: true, portee: { clients: [], automatisations: [] } };
const second: MembreDroits = { ...dirigeant, sujet: "kc-second-1", role: "second_administrateur", portee: { clients: ["11111111-1111-4111-8111-111111111111"], automatisations: [] } };
const CORPS = { email: "nadia.essai@exemple.fr", role: "dirigeant", portee_clients: [] };

function monter(o: { ouvert?: boolean; membre?: MembreDroits; ageSecondes?: number; acr?: string; inviter?: () => Promise<never> } = {}) {
  const appels: string[] = [];
  const traces: TraceRefus[] = [];
  const verificateur = async () => ({ sub: "kc-dirigeant-1", auth_time: Math.floor(MAINTENANT / 1000) - (o.ageSecondes ?? 10), acr: o.acr ?? "mfa" });
  const droits: DepsDroits = { membre: async () => o.membre ?? dirigeant, absenceOuverte: async () => false, tracer: async (e) => { traces.push(e); } };
  const service = {
    async lister() { appels.push("lister"); return [{ id: ID, role: "dirigeant" as const, actif: true, nombreClients: 0, creeLe: new Date(0), desactiveLe: null }]; },
    async inviter() { appels.push("inviter"); if (o.inviter) return o.inviter(); return { id: ID, role: "dirigeant" as const, nombreClients: 0, invitationEnvoyee: false }; },
    async desactiver() { appels.push("desactiver"); },
  };
  const d: DepsRoutesMembres = { ouvert: o.ouvert ?? true, exigerJeton: exigerJeton(verificateur), exigerReauthentification: exigerReauthentification(() => MAINTENANT), droits, service };
  const s = Fastify();
  brancherErreurs(s);
  routeMembres(s, d);
  return { s, appels, traces };
}
const BEARER = { authorization: "Bearer jeton-essai" };
const requete = (r: { methode: "GET" | "POST"; url: string; payload: object | undefined }, headers: Record<string, string>) => ({ method: r.methode, url: r.url, headers, ...(r.payload === undefined ? {} : { payload: r.payload }) });
const ROUTES = [
  { methode: "GET" as const, url: "/api/console/v1/equipe/membres", payload: undefined },
  { methode: "POST" as const, url: "/api/console/v1/equipe/membres", payload: CORPS },
  { methode: "POST" as const, url: `/api/console/v1/equipe/membres/${ID}/desactiver`, payload: {} },
];

describe("routes des membres de l'équipe", () => {
  it("[LOT3-securite] la porte fermée rend 503 sur chaque route de membres, sans appel", async () => {
    const { s, appels } = monter({ ouvert: false });
    for (const r of ROUTES) {
      const rep = await s.inject(requete(r, BEARER));
      expect(rep.statusCode, r.url).toBe(503);
      expect(rep.json().erreur.code).toBe("porte_fermee");
    }
    expect(appels).toEqual([]);
  });

  it("[LOT3-securite] un cookie sans en-tête Authorization rend 401 sur chaque geste de membres", async () => {
    const { s, appels } = monter();
    for (const r of ROUTES) {
      const rep = await s.inject(requete(r, { cookie: "sid=session-console-essai" }));
      expect(rep.statusCode, r.url).toBe(401);
    }
    expect(appels).toEqual([]);
  });

  it("[C-003] inviter et désactiver sans réauthentification récente rendent 401 reauthentification_requise, sans appel", async () => {
    for (const cas of [{ ageSecondes: 301 }, { acr: "1" }]) {
      const { s, appels } = monter(cas);
      for (const r of ROUTES.slice(1)) {
        const rep = await s.inject(requete(r, BEARER));
        expect(rep.statusCode, `${r.url} ${JSON.stringify(cas)}`).toBe(401);
        expect(rep.json().erreur.code).toBe("reauthentification_requise");
      }
      expect(appels).toEqual([]);
    }
  });

  it("[LOT3-securite] un second administrateur reçoit 403 sur chaque route de membres, et le refus est tracé", async () => {
    const { s, appels, traces } = monter({ membre: second });
    for (const r of ROUTES) {
      const rep = await s.inject(requete(r, BEARER));
      expect(rep.statusCode, r.url).toBe(403);
    }
    expect(appels).toEqual([]);
    expect(traces).toHaveLength(3);
    expect(traces.every((t) => t.action === "utilisateurs_roles" && t.sujet === "kc-second-1")).toBe(true);
  });

  it("[B-028] le dirigeant liste, invite (201) et désactive (204) ; la réponse n'a que des champs fermés", async () => {
    const { s, appels } = monter();
    const liste = await s.inject({ method: "GET", url: ROUTES[0]!.url, headers: BEARER });
    expect(liste.statusCode).toBe(200);
    expect(Object.keys(liste.json().membres[0]).sort()).toEqual(["actif", "cree_le", "desactive_le", "id", "nombre_clients", "role"]);
    const invite = await s.inject({ method: "POST", url: ROUTES[1]!.url, headers: BEARER, payload: CORPS });
    expect(invite.statusCode).toBe(201);
    expect(invite.json()).toEqual({ id: ID, role: "dirigeant", nombre_clients: 0, invitation_envoyee: false });
    const coupe = await s.inject({ method: "POST", url: ROUTES[2]!.url, headers: BEARER, payload: {} });
    expect(coupe.statusCode).toBe(204);
    expect(appels).toEqual(["lister", "inviter", "desactiver"]);
  });

  it("[B-028] un identifiant qui n'est pas un UUID rend 400 avant tout appel", async () => {
    const { s, appels } = monter();
    for (const mauvais of ["x", "..%2Fclients", "%2e%2e", "1"]) {
      const rep = await s.inject({ method: "POST", url: `/api/console/v1/equipe/membres/${mauvais}/desactiver`, headers: BEARER, payload: {} });
      expect([400, 404], mauvais).toContain(rep.statusCode);
    }
    expect(appels).toEqual([]);
  });

  it("[B-028] une erreur du service sort avec son code, jamais son texte brut", async () => {
    const { s } = monter({ inviter: async () => { throw new ErreurApi("identifiant_deja_pris", "Adresse déjà utilisée."); } });
    const rep = await s.inject({ method: "POST", url: ROUTES[1]!.url, headers: BEARER, payload: CORPS });
    expect(rep.statusCode).toBe(409);
    expect(rep.json().erreur.code).toBe("identifiant_deja_pris");
  });
});
