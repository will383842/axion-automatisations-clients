import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { brancherErreurs } from "../plugins/erreurs.js";
import { CHEMIN_CONSOLE, CHEMIN_PORTAIL, gestionnairesExport, type ServiceExport } from "./export.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const D = "33333333-3333-4333-8333-333333333333";
const LIMITE = new Date("2026-12-02T10:00:00Z");

function serveur(o: { reauth?: boolean; motifRefuse?: boolean } = {}) {
  const appels: string[] = [];
  const service: ServiceExport = {
    async demander(x) { appels.push(`demander:${x.tenantId}`); return { demande: D }; },
    async demanderParEquipe(x) { if (o.motifRefuse) throw new Error("motif_invalide"); appels.push(`equipe:${x.tenantId}:${x.motif}`); return { demande: D }; },
    async lien(x) { appels.push(`lien:${x.tenantId}:${x.demande ?? "-"}`); return { demande: D, expireLe: LIMITE, lien: "https://stockage.test/x", lienExpireLe: new Date("2026-11-05T10:15:00Z") }; },
  };
  const app = Fastify();
  brancherErreurs(app);
  const g = gestionnairesExport({
    service,
    exigerEquipe: async () => undefined,
    exigerReauth: async (_r, rep) => { if (o.reauth === false) return rep.status(401).send({ erreur: { code: "reauthentification_requise" } }); },
    session: async () => ({ tenantId: A }),
    acteurEquipe: () => "equipe:u1",
  });
  app.get(CHEMIN_PORTAIL, g.lire);
  app.post(CHEMIN_PORTAIL, g.demander);
  app.post(CHEMIN_CONSOLE, { preHandler: [g.exigerEquipe, g.exigerReauth] }, g.demanderParEquipe);
  return { app, appels };
}

describe("routes de l'export", () => {
  it("[B-371] POST /api/portail/v1/export : le client demande son export, le client vient de la session", async () => {
    const { app, appels } = serveur();
    const r = await app.inject({ method: "POST", url: CHEMIN_PORTAIL, payload: {}, headers: { "x-tenant": B } });
    expect(r.statusCode).toBe(202);
    expect(r.json()).toEqual({ demande: D });
    expect(appels).toEqual([`demander:${A}`]);
  });

  it("[A-252] GET /api/portail/v1/export : lien signé, dates d'expiration, aucune clé d'objet", async () => {
    const { app, appels } = serveur();
    const r = await app.inject({ method: "GET", url: `${CHEMIN_PORTAIL}?demande=${D}` });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ demande: D, expire_le: LIMITE.toISOString(), lien: "https://stockage.test/x", lien_expire_le: "2026-11-05T10:15:00.000Z" });
    expect(appels).toEqual([`lien:${A}:${D}`]);
    expect((await app.inject({ method: "GET", url: `${CHEMIN_PORTAIL}?demande=pas-un-uuid` })).statusCode).toBe(400);
  });

  it("[C-536] POST /api/console/v1/clients/:id/export : réauthentification et motif obligatoires", async () => {
    const sans = serveur({ reauth: false });
    expect((await sans.app.inject({ method: "POST", url: `/api/console/v1/clients/${B}/export`, payload: { motif: "fin_de_contrat" } })).statusCode).toBe(401);
    expect(sans.appels).toEqual([]);
    const { app, appels } = serveur();
    expect((await app.inject({ method: "POST", url: `/api/console/v1/clients/${B}/export`, payload: { motif: "au_hasard" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: `/api/console/v1/clients/pas-un-uuid/export`, payload: { motif: "fin_de_contrat" } })).statusCode).toBe(400);
    const ok = await app.inject({ method: "POST", url: `/api/console/v1/clients/${B}/export`, payload: { motif: "demande_ecrite_client" } });
    expect(ok.statusCode).toBe(202);
    expect(appels).toEqual([`equipe:${B}:demande_ecrite_client`]);
  });

  it("[C-536] un motif refusé par le service est une requête invalide (400), jamais une erreur interne", async () => {
    const { app, appels } = serveur({ motifRefuse: true });
    const r = await app.inject({ method: "POST", url: `/api/console/v1/clients/${B}/export`, payload: { motif: "fin_de_contrat" } });
    expect(r.statusCode).toBe(400);
    expect(appels).toEqual([]);
  });
});
