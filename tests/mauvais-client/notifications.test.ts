import { describe, expect, it } from "vitest";
import { brancherErreurs } from "../../apps/api/src/plugins/erreurs.js";
import { routeNotificationsPortail } from "../../apps/api/src/routes/portail/notifications.js";
import { fastifyVide } from "../../scripts/liste-routes.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const U1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const U2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const URL_PREF = "/api/portail/v1/notifications/preferences";

function monter() {
  const appels: unknown[][] = [];
  const appli = fastifyVide();
  brancherErreurs(appli);
  routeNotificationsPortail(appli, {
    ouvert: true,
    session: async () => ({ tenantId: A, acteur: U1 }),
    depot: { async lire(...a) { appels.push(["lire", ...a]); return { desactivees: [], resumeHebdomadaire: false }; }, async ecrire(...a) { appels.push(["ecrire", ...a]); } },
  });
  return { appli, appels };
}

describe("mauvais client : préférences de notification du portail", () => {
  it("[C-536] @isolation GET /api/portail/v1/notifications/preferences ignore tout client ou utilisateur désigné par l'adresse, un en-tête ou un cookie", async () => {
    const { appli, appels } = monter();
    const r = await appli.inject({ method: "GET", url: `${URL_PREF}?tenantId=${B}&utilisateur=${U2}`, headers: { "x-tenant": B, cookie: `tenant=${B}` } });
    expect(r.statusCode).toBe(200);
    expect(appels).toEqual([["lire", A, U1]]);
    expect(JSON.stringify(appels)).not.toContain(B);
    expect(JSON.stringify(appels)).not.toContain(U2);
    await appli.close();
  });

  it("[C-536] @isolation PUT /api/portail/v1/notifications/preferences d'un autre client : refus", async () => {
    const { appli, appels } = monter();
    const direct = await appli.inject({ method: "PUT", url: `${URL_PREF}?tenantId=${B}`, headers: { "x-tenant": B }, payload: { evenement: "rapportMensuel", activee: false } });
    expect(direct.statusCode).toBe(200);
    expect(appels).toEqual([["ecrire", A, U1, { evenement: "rapportMensuel", activee: false }]]);
    // Un client ou un utilisateur glissé dans le corps est refusé, rien n'est écrit de plus.
    for (const payload of [{ evenement: "rapportMensuel", activee: false, tenantId: B }, { evenement: "rapportMensuel", activee: false, utilisateur: U2 }]) {
      expect((await appli.inject({ method: "PUT", url: URL_PREF, payload })).statusCode).toBe(400);
    }
    expect(appels).toHaveLength(1);
    expect(JSON.stringify(appels)).not.toContain(B);
    await appli.close();
  });
});
