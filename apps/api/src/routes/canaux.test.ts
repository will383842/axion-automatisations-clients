import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { magasinEnMemoire } from "../canaux/expediteur.js";
import { brancherErreurs } from "../plugins/erreurs.js";
import { routeCanaux } from "./canaux.js";

const TENANT = randomUUID();
function monter(equipe = true) {
  const magasin = magasinEnMemoire();
  const serveur = Fastify();
  brancherErreurs(serveur);
  routeCanaux(serveur, { magasin, exigerEquipe: async (_r, rep) => { if (!equipe) return rep.status(403).send({ erreur: { code: "action_interdite" } }); } });
  const ref = magasin.deposer({ tenantId: TENANT, destination: "hub", route: "/api/console/v1/devis", methode: "POST", corps: { n: 1 }, cle: "3f2b8c1e-5a4d-4e6f-9b7a-1c2d3e4f5a6b" });
  return { magasin, serveur, ref };
}

describe("échecs de la boîte d'envoi (équipe)", () => {
  it("[C-403] GET /canaux/echecs liste les messages en échec, sans corps ni réponse", async () => {
    const { magasin, serveur, ref } = monter();
    await magasin.conclure(ref, { etat: "echec", erreur: "porte_fermee" });
    const r = await serveur.inject({ method: "GET", url: "/api/console/v1/canaux/echecs" });
    expect(r.statusCode).toBe(200);
    expect(r.json().echecs).toEqual([expect.objectContaining({ id: ref.id, destination: "hub", derniereErreur: "porte_fermee" })]);
    expect(JSON.stringify(r.json())).not.toContain('"corps"');
  });

  it("[C-403] renvoyer remet la ligne à envoyer avec la même clé ; une ligne qui n'est pas en échec n'est pas touchée", async () => {
    const { magasin, serveur, ref } = monter();
    const url = `/api/console/v1/canaux/echecs/${ref.tenantId}/${ref.id}/renvoyer`;
    expect((await serveur.inject({ method: "POST", url })).statusCode).toBe(404);
    await magasin.conclure(ref, { etat: "echec", erreur: "porte_fermee" });
    expect((await serveur.inject({ method: "POST", url })).statusCode).toBe(200);
    expect(magasin.lignes()[0]!.etat).toBe("a_envoyer");
  });

  it("[C-403] la route est réservée à l'équipe", async () => {
    const { serveur } = monter(false);
    expect((await serveur.inject({ method: "GET", url: "/api/console/v1/canaux/echecs" })).statusCode).toBe(403);
  });
});
