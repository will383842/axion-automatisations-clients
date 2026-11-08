import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { brancherErreurs } from "../../plugins/erreurs.js";
import { routeRevocationConnexion, type DepsRevocationConnexion, type SessionRevocation } from "./revocation.js";

const T = "11111111-1111-4111-8111-111111111111";
const AUTRE = "22222222-2222-4222-8222-222222222222";
const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const DIRIGEANT: SessionRevocation = { acteur: "will383842", role: "dirigeant", clientActifId: T, reauthentifie: true };

function serveur(session: SessionRevocation = DIRIGEANT, resultat: { etat: string; effacement?: string } = { etat: "revoquee", effacement: "fait" }) {
  const appels: unknown[][] = [];
  const app = Fastify();
  brancherErreurs(app);
  const deps: DepsRevocationConnexion = {
    exigerEquipe: (async () => undefined) as never,
    session: async () => session,
    revoquer: async (demande) => { appels.push([demande]); return resultat as never; },
  };
  routeRevocationConnexion(app, deps);
  return { app, appels };
}
const url = (id = T, c = C) => `/api/console/v1/clients/${id}/connexions/${c}/revoquer`;

describe("route : révoquer une connexion", () => {
  it("[A-393] révocation par le dirigeant : l'auteur vient de la session, le client de l'URL ; réponse sans valeur", async () => {
    const { app, appels } = serveur();
    const r = await app.inject({ method: "POST", url: url(), payload: { motif: "demande_client", acteur: "intrus" } });
    expect(r.statusCode).toBe(400); // l'auteur ne se saisit jamais
    const ok = await app.inject({ method: "POST", url: url(), payload: { motif: "demande_client" } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ etat: "revoquee", effacement: "fait" });
    expect(appels).toEqual([[{ tenantId: T, connexionId: C, acteur: "will383842", motif: "demande_client" }]]);
  });

  it("[A-393] second administrateur, rôle inconnu ou sans réauthentification : refus, rien n'est révoqué", async () => {
    for (const session of [{ ...DIRIGEANT, role: "second_administrateur" }, { ...DIRIGEANT, role: "inconnu" }, { ...DIRIGEANT, role: "" }, { ...DIRIGEANT, reauthentifie: false }, { ...DIRIGEANT, acteur: "systeme" }, { ...DIRIGEANT, acteur: " " }]) {
      const { app, appels } = serveur(session);
      const r = await app.inject({ method: "POST", url: url(), payload: { motif: "decision_dirigeant" } });
      expect([401, 403]).toContain(r.statusCode);
      expect(appels).toEqual([]);
    }
    expect((await serveur({ ...DIRIGEANT, reauthentifie: false }).app.inject({ method: "POST", url: url(), payload: { motif: "decision_dirigeant" } })).json().erreur.code).toBe("reauthentification_requise");
  });

  it("[A-393] client de l'URL différent du client actif : 403 ; connexion inconnue : 404 ; déjà révoquée : 409", async () => {
    const autre = serveur();
    expect((await autre.app.inject({ method: "POST", url: url(AUTRE), payload: { motif: "demande_client" } })).statusCode).toBe(403);
    expect(autre.appels).toEqual([]);
    expect((await serveur(DIRIGEANT, { etat: "inconnue" }).app.inject({ method: "POST", url: url(), payload: { motif: "demande_client" } })).statusCode).toBe(404);
    expect((await serveur(DIRIGEANT, { etat: "deja_revoquee" }).app.inject({ method: "POST", url: url(), payload: { motif: "demande_client" } })).statusCode).toBe(409);
    expect((await serveur(DIRIGEANT, { etat: "revoquee", effacement: "a_refaire" }).app.inject({ method: "POST", url: url(), payload: { motif: "demande_client" } })).json()).toEqual({ etat: "revoquee", effacement: "a_refaire" });
  });
});
