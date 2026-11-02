import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { magasinEnMemoire } from "../canaux/expediteur.js";
import { brancherErreurs } from "../plugins/erreurs.js";
import { routeCanaux } from "./canaux.js";

const TENANT = randomUUID();
function monter(equipe = true, acteur: string | null = "agent-essai", maintenant: () => number = Date.now) {
  const magasin = magasinEnMemoire(maintenant);
  const serveur = Fastify();
  brancherErreurs(serveur);
  routeCanaux(serveur, { magasin, exigerEquipe: async (r, rep) => { if (!equipe) return rep.status(403).send({ erreur: { code: "action_interdite" } }); if (acteur) r.identite = { sub: acteur }; } });
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

  it("[C-403] [A-091] renvoyer inscrit l'acteur, l'action et la ligne au journal d'audit", async () => {
    const { magasin, serveur, ref } = monter();
    await magasin.conclure(ref, { etat: "echec", erreur: "reseau" });
    await serveur.inject({ method: "POST", url: `/api/console/v1/canaux/echecs/${ref.tenantId}/${ref.id}/renvoyer` });
    expect(magasin.journal).toEqual([{ action: "renvoi", ligne: ref.id, acteur: "agent-essai" }]);
  });

  it("[C-403] [A-091] sans acteur identifié, renvoyer est refusé et la ligne reste en échec", async () => {
    const { magasin, serveur, ref } = monter(true, null);
    await magasin.conclure(ref, { etat: "echec", erreur: "reseau" });
    const r = await serveur.inject({ method: "POST", url: `/api/console/v1/canaux/echecs/${ref.tenantId}/${ref.id}/renvoyer` });
    expect(r.statusCode).toBe(403);
    expect(magasin.lignes()[0]!.etat).toBe("echec");
    expect(magasin.journal).toEqual([]);
  });

  it("[C-403] [A-091] le magasin refuse un renvoi sans acteur valide", async () => {
    const { magasin, ref } = monter();
    await magasin.conclure(ref, { etat: "echec", erreur: "reseau" });
    await expect(magasin.renvoyer(ref, { acteur: "" })).rejects.toThrow(/acteur/);
    expect(magasin.lignes()[0]!.etat).toBe("echec");
  });

  it("[C-403] [C-535] une ligne de plus de 30 jours n'est pas renvoyée sans confirmation explicite (31 jours refusé, 29 jours accepté)", async () => {
    const JOUR = 86_400_000;
    const { magasin, serveur, ref } = monter(true, "agent-essai", () => Date.now());
    const vieille = magasin.deposer({ tenantId: TENANT, destination: "hub", route: "/api/console/v1/devis", methode: "POST", corps: { n: 2 }, cle: "4a3b8c1e-5a4d-4e6f-9b7a-1c2d3e4f5a6b", creeLe: new Date(Date.now() - 31 * JOUR) });
    const recente = magasin.deposer({ tenantId: TENANT, destination: "hub", route: "/api/console/v1/devis", methode: "POST", corps: { n: 3 }, cle: "5a3b8c1e-5a4d-4e6f-9b7a-1c2d3e4f5a6b", creeLe: new Date(Date.now() - 29 * JOUR) });
    for (const x of [ref, vieille, recente]) await magasin.conclure(x, { etat: "echec", erreur: "reseau" });
    const url = (x: { tenantId: string; id: string }) => `/api/console/v1/canaux/echecs/${x.tenantId}/${x.id}/renvoyer`;
    const refus = await serveur.inject({ method: "POST", url: url(vieille) });
    expect(refus.statusCode).toBe(422);
    expect(magasin.lignes().find((l) => l.id === vieille.id)!.etat).toBe("echec");
    expect(magasin.journal.some((j) => j.ligne === vieille.id)).toBe(false);
    expect((await serveur.inject({ method: "POST", url: url(recente) })).statusCode).toBe(200);
    const confirme = await serveur.inject({ method: "POST", url: url(vieille), payload: { confirmerAnciennete: true } });
    expect(confirme.statusCode).toBe(200);
    expect(magasin.lignes().find((l) => l.id === vieille.id)!.etat).toBe("a_envoyer");
  });

  it("[C-403] la route est réservée à l'équipe", async () => {
    const { serveur } = monter(false);
    expect((await serveur.inject({ method: "GET", url: "/api/console/v1/canaux/echecs" })).statusCode).toBe(403);
  });
});
