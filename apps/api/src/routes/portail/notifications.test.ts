import { describe, expect, it } from "vitest";
import { brancherErreurs } from "../../plugins/erreurs.js";
import { fastifyVide } from "../../../../../scripts/liste-routes.js";
import { routeNotificationsPortail, type DepotPreferences } from "./notifications.js";

const A = "11111111-1111-4111-8111-111111111111";
const U1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const URL_PREF = "/api/portail/v1/notifications/preferences";

function monter(ouvert = true) {
  const lectures: unknown[][] = [];
  const ecritures: unknown[][] = [];
  const depot: DepotPreferences = {
    async lire(...a) { lectures.push(a); return { desactivees: ["brouillonEnAttente"], resumeHebdomadaire: false }; },
    async ecrire(...a) { ecritures.push(a); },
  };
  const appli = fastifyVide();
  brancherErreurs(appli);
  routeNotificationsPortail(appli, { ouvert, session: async () => ({ tenantId: A, acteur: U1 }), depot });
  return { appli, lectures, ecritures };
}

describe("routes des préférences de notification", () => {
  it("[B-141] la rubrique Notifications liste les préférences de l'utilisateur seulement", async () => {
    const { appli, lectures } = monter();
    const r = await appli.inject({ method: "GET", url: URL_PREF });
    expect(r.statusCode).toBe(200);
    expect(lectures).toEqual([[A, U1]]);
    const corps = r.json() as { preferences: { evenement: string; desactivable: boolean; activee: boolean }[]; resumeHebdomadaire: boolean };
    expect(corps.preferences.find((p) => p.evenement === "brouillonEnAttente")).toEqual({ evenement: "brouillonEnAttente", desactivable: true, activee: false });
    expect(corps.preferences.find((p) => p.evenement === "rapportMensuel")).toEqual({ evenement: "rapportMensuel", desactivable: true, activee: true });
    expect(corps.preferences.find((p) => p.evenement === "palier100Client")).toEqual({ evenement: "palier100Client", desactivable: false, activee: true });
    expect(corps.resumeHebdomadaire).toBe(false);
  });

  it("[B-141] PUT sur une ligne non désactivable : 422, rien n'est écrit", async () => {
    const { appli, ecritures } = monter();
    for (const evenement of ["palier100Client", "inconnu", "resumeHebdomadaire"]) {
      const r = await appli.inject({ method: "PUT", url: URL_PREF, payload: { evenement, activee: false } });
      expect(r.statusCode, evenement).toBe(422);
    }
    expect(ecritures).toEqual([]);
    const ok = await appli.inject({ method: "PUT", url: URL_PREF, payload: { evenement: "rapportMensuel", activee: false } });
    expect(ok.statusCode).toBe(200);
    expect(ecritures).toEqual([[A, U1, { evenement: "rapportMensuel", activee: false }]]);
  });

  it("[B-186] le choix du résumé hebdomadaire s'écrit sur la ligne réservée, et un corps mal formé est refusé", async () => {
    const { appli, ecritures } = monter();
    expect((await appli.inject({ method: "PUT", url: URL_PREF, payload: { resumeHebdomadaire: true } })).statusCode).toBe(200);
    expect(ecritures).toEqual([[A, U1, { resumeHebdomadaire: true }]]);
    for (const payload of [{}, { evenement: "rapportMensuel" }, { evenement: "rapportMensuel", activee: "oui" }, { resumeHebdomadaire: true, tenantId: A }]) {
      expect((await appli.inject({ method: "PUT", url: URL_PREF, payload })).statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect(ecritures).toHaveLength(1);
  });

  it("[B-141] la route est fermée par défaut", async () => {
    const { appli, lectures, ecritures } = monter(false);
    expect((await appli.inject({ method: "GET", url: URL_PREF })).statusCode).toBe(503);
    expect((await appli.inject({ method: "PUT", url: URL_PREF, payload: { resumeHebdomadaire: true } })).statusCode).toBe(503);
    expect([...lectures, ...ecritures]).toEqual([]);
  });
});
