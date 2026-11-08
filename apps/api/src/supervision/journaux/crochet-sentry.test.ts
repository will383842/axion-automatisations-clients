import { createHmac, randomBytes } from "node:crypto";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { brancherErreurs } from "../../plugins/erreurs.js";
import { routeCrochetSentry, type TacheSentry } from "./crochet-sentry.js";

// Secret généré au lancement, jamais écrit.
const SECRET = randomBytes(24).toString("hex");
const signer = (corps: string, secret = SECRET) => createHmac("sha256", secret).update(corps).digest("hex");
const evenement = (o: Record<string, unknown> = {}) => JSON.stringify({ action: "triggered", data: { event: { event_id: "0123456789abcdef0123456789abcdef", title: "Erreur chez marc@exemple.fr", web_url: "https://de.sentry.io/organizations/atelier-bertin/issues/42/", culprit: "ne pas recopier", request: { data: "ne pas recopier" }, ...o } } });

function monter(ouvert = true) {
  const app = Fastify();
  brancherErreurs(app);
  const taches = new Map<string, TacheSentry>();
  routeCrochetSentry(app, { ouvert: () => ouvert, secret: () => SECRET, taches: { async creer(t) { taches.set(t.idEvenement, t); } } });
  const poster = (corps: string, entetes: Record<string, string> = { "sentry-hook-signature": signer(corps) }) =>
    app.inject({ method: "POST", url: "/api/console/v1/sentry/crochet", headers: { "content-type": "application/json", ...entetes }, payload: corps });
  return { taches, poster };
}

describe("crochet Sentry vers une tâche du chef d'orchestre", () => {
  it("[C-387] un crochet Sentry à la signature valide crée une seule tâche (titre masqué, lien sentry.io) et rien d'autre", async () => {
    const { taches, poster } = monter();
    const corps = evenement();
    expect((await poster(corps)).statusCode).toBe(202);
    expect((await poster(corps)).statusCode).toBe(202);
    expect([...taches.values()]).toEqual([{ idEvenement: "0123456789abcdef0123456789abcdef", titre: "Erreur chez [masqué]", lien: "https://de.sentry.io/organizations/atelier-bertin/issues/42/" }]);
    expect(JSON.stringify([...taches.values()])).not.toContain("ne pas recopier");
  });

  it("[C-387] signature absente, fausse ou de longueur différente : 401, aucune tâche", async () => {
    const { taches, poster } = monter();
    const corps = evenement();
    for (const entetes of [{}, { "sentry-hook-signature": signer(corps, "autre") }, { "sentry-hook-signature": "abc" }, { "sentry-hook-signature": `${signer(corps)}00` }]) {
      expect((await poster(corps, entetes)).statusCode).toBe(401);
    }
    expect((await poster(evenement({ title: "autre" }), { "sentry-hook-signature": signer(corps) })).statusCode).toBe(401);
    expect(taches.size).toBe(0);
    const ferme = monter(false);
    expect((await ferme.poster(corps)).statusCode).toBe(503);
    expect(ferme.taches.size).toBe(0);
  });

  it("[C-387] un lien qui ne pointe pas vers *.sentry.io est refusé", async () => {
    const { taches, poster } = monter();
    for (const lien of ["https://evil.test/x", "https://sentry.io.evil.test/x", "http://de.sentry.io/x", "https://de.sentry.io@evil.test/x", "https://notsentry.io/x", "javascript:alert(1)", "pas un lien"]) {
      expect((await poster(evenement({ web_url: lien }))).statusCode).toBe(400);
    }
    expect(taches.size).toBe(0);
  });
});
