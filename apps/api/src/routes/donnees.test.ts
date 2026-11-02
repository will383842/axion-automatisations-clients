import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { brancherErreurs } from "../plugins/erreurs.js";
import { routeDonnees } from "./donnees.js";
import type { SessionDonnees } from "../donnees/service.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
async function appli() {
  const vus: { session: SessionDonnees; nom: string; parametres: unknown }[] = [];
  const s = Fastify();
  brancherErreurs(s);
  const session: SessionDonnees = { tenantId: A, role: "client", acteur: "u1", etablissements: [] };
  routeDonnees(s, { session: async () => session, executer: async (se, nom, parametres) => { vus.push({ session: se, nom, parametres }); return [{ total: 1 }]; } });
  await s.ready();
  return { s, vus };
}

describe("route des données client", () => {
  it("[C-536] @isolation un client, un en-tête X-Tenant, un cookie ou un chemin de l'autre client sont ignorés : la session décide", async () => {
    const { s, vus } = await appli();
    const r = await s.inject({ method: "POST", url: `/api/v1/donnees/compterPersonnes?tenantId=${B}`, headers: { "x-tenant": B, cookie: `tenant=${B}` }, payload: { tenantId: B } });
    expect(r.statusCode).toBe(200);
    expect(vus[0]!.session.tenantId).toBe(A);
    expect(vus[0]!.parametres).toEqual({ tenantId: B });
  });

  it("[B-172] un nom de requête mal formé est refusé avant le service", async () => {
    const { s, vus } = await appli();
    expect((await s.inject({ method: "POST", url: "/api/v1/donnees/a%20b;drop", payload: {} })).statusCode).toBe(400);
    expect(vus).toEqual([]);
  });
});
