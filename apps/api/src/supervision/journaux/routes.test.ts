import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { exigerEquipeParRole } from "../../serveur.js";
import { exigerReauthentification } from "../../auth/exiger-reauthentification.js";
import { brancherErreurs } from "../../plugins/erreurs.js";
import { construireServeur } from "../../serveur.js";
import { routeJournaux, type DepsJournaux } from "./routes.js";

const MAINTENANT = Date.parse("2026-11-08T10:00:00Z");
type Session = { equipe: boolean; role: string; auth_time?: number; acr?: string };
const URL = `/api/console/v1/journaux?brique=api&depuis=${encodeURIComponent("2026-11-07T10:00:00Z")}`;

function monter(session: Session, ouvert = true) {
  const app = Fastify();
  brancherErreurs(app);
  const appels: unknown[] = [];
  const d: DepsJournaux = {
    ouvert: () => ouvert,
    exigerEquipe: async (requete, reponse) => {
      (requete as { identite?: unknown }).identite = { auth_time: session.auth_time, acr: session.acr };
      await exigerEquipeParRole(async () => session)(requete, reponse);
    },
    exigerReauthentification: exigerReauthentification(() => MAINTENANT),
    lecture: { url: "http://collecteur.test:9428", fetch: async (_u, init) => { appels.push(init.body); return { status: 200, text: async () => JSON.stringify({ _time: "2026-11-08T09:00:00Z", _msg: "démarré", application: "api" }) }; }, maintenant: () => MAINTENANT },
  };
  routeJournaux(app, d);
  return { app, appels };
}
const recent = { auth_time: Math.floor(MAINTENANT / 1000) - 60, acr: "mfa" };

describe("route de lecture des journaux", () => {
  it("[A-080] @isolation une session client reçoit 403", async () => {
    const { app, appels } = monter({ equipe: false, role: "client", ...recent });
    const r = await app.inject({ method: "GET", url: URL });
    expect(r.statusCode).toBe(403);
    expect(appels).toHaveLength(0);
    const lecteur = monter({ equipe: true, role: "lecteur", ...recent });
    expect((await lecteur.app.inject({ method: "GET", url: URL })).statusCode).toBe(403);
  });

  it("[A-080] sans réauthentification récente, la lecture des journaux est refusée", async () => {
    for (const s of [{ auth_time: Math.floor(MAINTENANT / 1000) - 3600, acr: "mfa" }, { auth_time: Math.floor(MAINTENANT / 1000) - 10, acr: "pwd" }, {}]) {
      const { app, appels } = monter({ equipe: true, role: "dirigeant", ...s });
      const r = await app.inject({ method: "GET", url: URL });
      expect(r.statusCode).toBe(401);
      expect(r.json().erreur.code).toBe("reauthentification_requise");
      expect(appels).toHaveLength(0);
    }
    const bon = monter({ equipe: true, role: "dirigeant", ...recent });
    const ok = await bon.app.inject({ method: "GET", url: URL });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().lignes).toHaveLength(1);
  });

  it("[A-080] la route est fermée par défaut (503) et n'existe pas sans dépendances", async () => {
    const ferme = monter({ equipe: true, role: "dirigeant", ...recent }, false);
    expect((await ferme.app.inject({ method: "GET", url: URL })).statusCode).toBe(503);
    expect(ferme.appels).toHaveLength(0);
    const sans = construireServeur({});
    expect(sans.hasRoute({ method: "GET", url: "/api/console/v1/journaux" })).toBe(false);
    expect((await sans.inject({ method: "GET", url: URL })).statusCode).toBe(404);
  });
});
