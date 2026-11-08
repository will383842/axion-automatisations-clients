import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { brancherErreurs } from "../../plugins/erreurs.js";
import { routeLiensConnexions, type DepsLiensConnexions, type SessionConnexions } from "./liens.js";

const T = "11111111-1111-4111-8111-111111111111";
const AUTRE = "22222222-2222-4222-8222-222222222222";
const ORG = "33333333-3333-4333-8333-333333333333";
const NOUVELLE = "44444444-4444-4444-8444-444444444444";
const SECRET_GOOGLE = "marqueur-secret-application-google-9d3a";
const DIRIGEANT: SessionConnexions = { acteur: "will383842", role: "dirigeant", clientActifId: T, reauthentifie: true };
const CORPS = { organisation_id: ORG, outil: "microsoft-365", connecteur: "microsoft-graph", portee: "lecture", locataire_attendu: "55555555-5555-4555-8555-555555555555" };

function serveur(session: SessionConnexions = DIRIGEANT, ouvert = true) {
  const appels: [string, ...unknown[]][] = [];
  const app = Fastify();
  brancherErreurs(app);
  const deps: DepsLiensConnexions = {
    exigerEquipe: (async () => undefined) as never,
    session: async () => session,
    porte: (outil) => (appels.push(["porte", outil]), ouvert),
    nouvelId: () => NOUVELLE,
    creer: async (c) => { appels.push(["creer", c]); },
    ecrireCoffre: async (chemin, valeur) => { appels.push(["coffre", chemin, valeur]); },
    emettreLien: async (c) => { appels.push(["lien", c]); return "v1.k1.charge.signature"; },
  };
  routeLiensConnexions(app, deps);
  return { app, appels };
}
const url = (id = T) => `/api/console/v1/clients/${id}/connexions/liens`;

describe("route : créer un lien de connexion", () => {
  it("[B-092] création d'un lien : 201 avec le lien seul ; le secret de l'application Google n'est jamais renvoyé", async () => {
    const { app, appels } = serveur();
    const r = await app.inject({ method: "POST", url: url(), payload: { organisation_id: ORG, outil: "gmail", connecteur: "gmail-api", portee: "lecture", domaine_attendu: "exemple.fr", application_google: { client_id: "id-essai.apps.test", client_secret: SECRET_GOOGLE } } });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toEqual({ connexion_id: NOUVELLE, lien: "v1.k1.charge.signature" });
    expect(r.body).not.toContain(SECRET_GOOGLE);
    const creation = appels.find((a) => a[0] === "creer")?.[1] as Record<string, unknown>;
    expect(creation).toMatchObject({ tenantId: T, acteur: "will383842", connexionId: NOUVELLE, referenceCoffre: `bao:clients/${T}/connexions/${NOUVELLE}/jetons` });
    expect(JSON.stringify(creation)).not.toContain(SECRET_GOOGLE);
    expect(appels.find((a) => a[0] === "coffre")).toEqual(["coffre", `clients/${T}/connexions/${NOUVELLE}/application`, { client_id: "id-essai.apps.test", client_secret: SECRET_GOOGLE }]);
  });

  it("[B-092] outil dont la porte est fermée : 503 porte_fermee, rien n'est créé", async () => {
    const { app, appels } = serveur(DIRIGEANT, false);
    const r = await app.inject({ method: "POST", url: url(), payload: CORPS });
    expect(r.statusCode).toBe(503);
    expect(r.json().erreur.code).toBe("porte_fermee");
    expect(appels.map((a) => a[0])).toEqual(["porte"]);
  });

  it("[A-390] lien IMAP pour un client Google sans attestation_workspace : 422", async () => {
    const { app, appels } = serveur();
    const base = { organisation_id: ORG, outil: "gmail", connecteur: "imap", portee: "lecture" };
    for (const corps of [base, { ...base, attestation_workspace: false }]) {
      const r = await app.inject({ method: "POST", url: url(), payload: corps });
      expect(r.statusCode).toBe(422);
      expect(r.json().erreur.code).toBe("regle_metier");
    }
    expect(appels).toEqual([]);
    // Témoin : avec l'attestation, la connexion naît (l'INSERT audité porte l'auteur de l'attestation).
    expect((await app.inject({ method: "POST", url: url(), payload: { ...base, attestation_workspace: true } })).statusCode).toBe(201);
  });

  it("[B-092] corps hors schéma, client de l'URL différent du client actif, rôle sans droit sur les secrets : refus, rien n'est créé", async () => {
    const mauvais = [
      await serveur().app.inject({ method: "POST", url: url(), payload: { ...CORPS, tenant_id: AUTRE } }),
      await serveur().app.inject({ method: "POST", url: url(), payload: { ...CORPS, outil: "inconnu" } }),
      await serveur().app.inject({ method: "POST", url: url(), payload: { ...CORPS, application_google: { client_id: "x", client_secret: "y" } } }),
    ];
    expect(mauvais.map((r) => r.statusCode)).toEqual([400, 400, 400]);
    const autreClient = serveur();
    expect((await autreClient.app.inject({ method: "POST", url: url(AUTRE), payload: CORPS })).statusCode).toBe(403);
    expect(autreClient.appels).toEqual([]);
    for (const role of ["second_administrateur", "inconnu", ""]) {
      const s = serveur({ ...DIRIGEANT, role });
      expect((await s.app.inject({ method: "POST", url: url(), payload: CORPS })).statusCode).toBe(403);
      expect(s.appels).toEqual([]);
    }
  });
});
