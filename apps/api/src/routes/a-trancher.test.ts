import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { brancherErreurs } from "../plugins/erreurs.js";
import { routeATrancher } from "./a-trancher.js";

const ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
function serveur(equipe = true, reauth = true) {
  const appliquer = vi.fn(async () => undefined);
  const ecarter = vi.fn(async () => undefined);
  const app = Fastify();
  brancherErreurs(app);
  routeATrancher(app, {
    exigerEquipe: async (_r, rep) => { if (!equipe) return rep.status(403).send({ erreur: { code: "interdit" } }); },
    appelant: () => ({ acteur: "equipe-essai" }),
    reauthentifie: () => reauth,
    appliquer,
    ecarter,
  });
  return { app, appliquer, ecarter };
}

describe("routes à trancher", () => {
  it("[C-365] appliquer : réservé à l'équipe, l'identifiant doit être un UUID, la réauthentification est transmise", async () => {
    const { app, appliquer } = serveur();
    expect((await app.inject({ method: "POST", url: `/api/console/v1/a-trancher/${ID}/appliquer` })).statusCode).toBe(204);
    expect(appliquer).toHaveBeenCalledWith(ID, { acteur: "equipe-essai" }, true);
    expect((await app.inject({ method: "POST", url: "/api/console/v1/a-trancher/pas-un-uuid/appliquer" })).statusCode).toBe(400);
    const sans = serveur(false);
    expect((await sans.app.inject({ method: "POST", url: `/api/console/v1/a-trancher/${ID}/appliquer` })).statusCode).toBe(403);
    expect(sans.appliquer).not.toHaveBeenCalled();
  });

  it("[C-365] écarter : le motif est obligatoire et borné, rien n'est appelé sans lui", async () => {
    const { app, ecarter } = serveur();
    expect((await app.inject({ method: "POST", url: `/api/console/v1/a-trancher/${ID}/ecarter`, payload: {} })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: `/api/console/v1/a-trancher/${ID}/ecarter`, payload: { motif: "x".repeat(501) } })).statusCode).toBe(400);
    expect(ecarter).not.toHaveBeenCalled();
    expect((await app.inject({ method: "POST", url: `/api/console/v1/a-trancher/${ID}/ecarter`, payload: { motif: "déjà corrigé" } })).statusCode).toBe(204);
    expect(ecarter).toHaveBeenCalledWith(ID, { acteur: "equipe-essai" }, "déjà corrigé");
  });
});
