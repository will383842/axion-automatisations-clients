import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { brancherGardePortail } from "./garde.ts";
import { creerSessionPortail } from "./session.ts";
import { brancherErreurs, ErreurApi } from "../plugins/erreurs.js";
import type { RoleClient } from "./roles.ts";

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const X = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const Y = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const ABSENTE = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

function construire(o: { role?: RoleClient; org?: string; jeton?: boolean; perimetre?: string[]; reponse?: unknown } = {}) {
  const appels: string[] = [];
  const s = Fastify();
  brancherErreurs(s);
  const session = creerSessionPortail({
    verifier: async () => { if (o.jeton === false) throw new Error("refusé"); return { sub: "u", azp: "portail", roles_portail: [o.role ?? "administrateur"], organisations: [`/organisations/${o.org ?? ORG_A}`] } as never; },
    azp: "portail",
    statutOrganisation: async () => "client",
    etablissements: async () => [],
    perimetre: async () => ({ automatisations: o.perimetre ?? [X], etablissements: [] }),
  });
  brancherGardePortail(s, { session });
  const base = new Map([[ORG_A, new Set([X])], [ORG_B, new Set([Y])]]);
  s.get("/api/portail/v1/automatisations/:instance", async (r) => {
    appels.push("service");
    const sess = await session(r);
    if (!base.get(sess.tenantId)?.has((r.params as { instance: string }).instance)) throw new ErreurApi("introuvable", "Ressource introuvable.");
    return o.reponse ?? { id: (r.params as { instance: string }).instance };
  });
  s.get("/api/portail/v1/sans-regle", async () => ({ ok: true }));
  s.get("/api/portail/v1/factures", async () => ({ ok: true }));
  return { s, appels };
}
const get = (s: ReturnType<typeof construire>["s"], url: string, entetes: Record<string, string> = {}) => s.inject({ method: "GET", url, headers: { authorization: "Bearer x", ...entetes } });

describe("garde du portail", () => {
  it("[B-183] un utilisateur limité à l'automatisation X reçoit 404 sur Y, réponse identique à une automatisation inexistante", async () => {
    const { s, appels } = construire({ role: "utilisateur" });
    expect((await get(s, `/api/portail/v1/automatisations/${X}`)).statusCode).toBe(200);
    const y = await get(s, `/api/portail/v1/automatisations/${Y}`);
    const absente = await get(s, `/api/portail/v1/automatisations/${ABSENTE}`);
    expect(y.statusCode).toBe(404);
    expect(absente.statusCode).toBe(404);
    expect(JSON.parse(y.body).erreur.code).toBe(JSON.parse(absente.body).erreur.code);
    expect(JSON.parse(y.body).erreur.message).toBe(JSON.parse(absente.body).erreur.message);
    expect(appels).toEqual(["service"]);
  });

  it("[A-004] aucune route du portail ne renvoie un identifiant d'exécuteur, de cellule ou de version de module", async () => {
    for (const cle of ["executeurId", "cellule_id", "version_module", "moduleVersionId"]) {
      const { s } = construire({ reponse: { liste: [{ [cle]: "v" }] } });
      const r = await get(s, `/api/portail/v1/automatisations/${X}`);
      expect(r.statusCode).toBe(500);
      expect(r.body).not.toContain('"v"');
    }
    const { s } = construire({ reponse: { liste: [{ nom: "ok" }] } });
    expect((await get(s, `/api/portail/v1/automatisations/${X}`)).statusCode).toBe(200);
  });

  it("[A-004] @isolation un utilisateur de A qui force l'identifiant d'une ressource de B reçoit 404", async () => {
    for (const role of ["utilisateur", "administrateur"] as RoleClient[]) {
      const { s } = construire({ role, perimetre: [X, Y] });
      expect((await get(s, `/api/portail/v1/automatisations/${Y}`)).statusCode).toBe(404);
    }
  });

  it("[C-501] toute route /api/portail/v1 sans règle déclarée reçoit 403, et toute route du portail de listerRoutes() a sa règle", async () => {
    const { s } = construire();
    expect((await get(s, "/api/portail/v1/sans-regle")).statusCode).toBe(403);
    expect((await get(s, "/api/portail/v1/factures")).statusCode).toBe(200);
    const { lister } = (await import("../routes/branchements/portail-donnees-module.ts")).default;
    const routes: string[] = [];
    const faux = { post: (u: string) => routes.push(`POST ${u}`), get: (u: string) => routes.push(`GET ${u}`), put: (u: string) => routes.push(`PUT ${u}`), patch: (u: string) => routes.push(`PATCH ${u}`), delete: (u: string) => routes.push(`DELETE ${u}`) };
    lister(faux as never);
    const { regleDeclaree } = await import("./roles.ts");
    expect(routes.length).toBeGreaterThan(0);
    for (const r of routes) expect(regleDeclaree(r.split(" ")[0] ?? "", r.split(" ")[1] ?? "")).toBe(true);
  });

  it("[LOT6-roles] session absente ou jeton refusé : 401 avant tout appel au service", async () => {
    const { s, appels } = construire({ jeton: false });
    expect((await get(s, `/api/portail/v1/automatisations/${X}`)).statusCode).toBe(401);
    expect(appels).toEqual([]);
  });

  it("[LOT6-roles] rôle refusé : 403, sans appel au service", async () => {
    const { s, appels } = construire({ role: "comptable" });
    expect((await get(s, `/api/portail/v1/automatisations/${X}`)).statusCode).toBe(403);
    expect(appels).toEqual([]);
  });
});
