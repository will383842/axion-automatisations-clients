import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ErreurApi, brancherErreurs } from "../../apps/api/src/plugins/erreurs.js";
import { routeCrochetSentry } from "../../apps/api/src/supervision/journaux/crochet-sentry.js";
import { routeJournaux } from "../../apps/api/src/supervision/journaux/routes.js";
import { fastifyVide } from "../../scripts/liste-routes.js";

// Journaux regroupés (T5-13b-4) : une session hors équipe reçoit 403 sans aucune lecture du collecteur ; le crochet Sentry sans signature valide ne crée rien.
const DEPUIS = encodeURIComponent(new Date(Date.now() - 3_600_000).toISOString());

describe("journaux regroupés : appelant hors équipe", () => {
  it("[C-536] @isolation GET /api/console/v1/journaux", async () => {
    const app = fastifyVide();
    brancherErreurs(app);
    let lectures = 0;
    const refus = async () => { throw new ErreurApi("action_interdite", "Action interdite."); };
    const passe = async () => undefined;
    routeJournaux(app, { ouvert: () => true, exigerEquipe: refus, exigerReauthentification: passe, lecture: { url: "http://collecteur.test:9428", fetch: async () => { lectures++; return { status: 200, text: async () => "" }; } } });
    const r = await app.inject({ method: "GET", url: `/api/console/v1/journaux?brique=api&depuis=${DEPUIS}` });
    expect(r.statusCode).toBe(403);
    expect(lectures).toBe(0);
  });

  it("[C-536] @isolation POST /api/console/v1/sentry/crochet", async () => {
    const app = fastifyVide();
    brancherErreurs(app);
    let taches = 0;
    routeCrochetSentry(app, { ouvert: () => true, secret: () => "secret-de-test", taches: { creer: async () => { taches++; } } });
    const corps = JSON.stringify({ data: { event: { event_id: "abcdef0123456789", title: "t", web_url: "https://de.sentry.io/x" } } });
    const r = await app.inject({ method: "POST", url: "/api/console/v1/sentry/crochet", headers: { "content-type": "application/json", "sentry-hook-signature": createHmac("sha256", "autre").update(corps).digest("hex") }, payload: corps });
    expect(r.statusCode).toBe(401);
    expect(taches).toBe(0);
  });
});
