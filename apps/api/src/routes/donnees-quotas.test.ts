import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { brancherErreurs } from "../plugins/erreurs.js";
import { lireConfigQuotas } from "../quotas/paliers.js";
import { CHEMIN_CONSOLE, CHEMIN_PORTAIL, gestionnairesDonneesQuotas, type SourceEtat } from "./donnees-quotas.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const CONFIG = lireConfigQuotas(JSON.stringify({
  essentiel: { base_octets: 1000, fichiers_octets: 2000, personnes: 100 },
  pro: { base_octets: 2000, fichiers_octets: 4000, personnes: 200 },
  etendu: { base_octets: 3000, fichiers_octets: 6000, personnes: 300 },
}));
const SAUVEGARDE = new Date("2026-11-02T03:00:00Z");
const EXPORT = new Date("2026-10-15T08:00:00Z");
const MESURE = new Date("2026-11-02T10:00:00Z");

const SOURCES: Record<string, SourceEtat> = {
  [A]: { palier: "pro", surcharge: { personnes: 50 }, mesures: { baseOctets: 1500, fichiersOctets: 400, personnes: 50, mesureLe: MESURE }, importsEnCours: 2, derniereSauvegarde: SAUVEGARDE, dernierExport: EXPORT },
  [B]: { palier: "etendu", surcharge: {}, mesures: { baseOctets: 9, fichiersOctets: 9, personnes: 9, mesureLe: MESURE }, importsEnCours: 7, derniereSauvegarde: null, dernierExport: null },
};

function serveur(sessionPortail: string = A) {
  const lus: string[] = [];
  const app = Fastify();
  brancherErreurs(app);
  const g = gestionnairesDonneesQuotas({
    config: CONFIG,
    exigerEquipe: async () => undefined,
    session: async () => ({ tenantId: sessionPortail }),
    async source(t) { lus.push(t); return SOURCES[t]; },
  });
  app.get(CHEMIN_CONSOLE, { preHandler: g.exigerEquipe }, g.console);
  app.get(CHEMIN_PORTAIL, g.portail);
  return { app, lus };
}

describe("routes des données et des quotas", () => {
  it("[B-040] la console reçoit tailles, volumes, imports en cours, dernière sauvegarde et export", async () => {
    const { app } = serveur();
    const r = await app.inject({ method: "GET", url: `/api/console/v1/clients/${A}/donnees` });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({
      palier: "pro",
      base: { taille_octets: 1500, quota_octets: 2000, pourcentage_bps: 7500 },
      fichiers: { taille_octets: 400, quota_octets: 4000, pourcentage_bps: 1000 },
      personnes: { nombre: 50, quota: 50, pourcentage_bps: 10000 },
      alerte: "quota_atteint",
      imports_en_cours: 2,
      derniere_sauvegarde: "2026-11-02T03:00:00.000Z",
      dernier_export: "2026-10-15T08:00:00.000Z",
      mesure_le: "2026-11-02T10:00:00.000Z",
    });
  });

  it("[B-040] la console refuse un identifiant mal formé et ne dit rien d'un client inconnu", async () => {
    const { app } = serveur();
    expect((await app.inject({ method: "GET", url: "/api/console/v1/clients/pas-un-uuid/donnees" })).statusCode).toBe(400);
    const inconnu = await app.inject({ method: "GET", url: "/api/console/v1/clients/33333333-3333-4333-8333-333333333333/donnees" });
    expect(inconnu.statusCode).toBe(404);
    expect(JSON.stringify(inconnu.json())).not.toContain("33333333");
  });

  it("[B-040] sans mesure ni sauvegarde, les champs sont nuls et aucune alerte n'est annoncée", async () => {
    const app = Fastify();
    brancherErreurs(app);
    const g = gestionnairesDonneesQuotas({ config: CONFIG, exigerEquipe: async () => undefined, session: async () => ({ tenantId: A }), source: async () => ({ palier: "essentiel", surcharge: {}, mesures: undefined, importsEnCours: 0, derniereSauvegarde: null, dernierExport: null }) });
    app.get(CHEMIN_PORTAIL, g.portail);
    const j = (await app.inject({ method: "GET", url: "/api/portail/v1/donnees" })).json();
    expect(j).toMatchObject({ palier: "essentiel", alerte: "aucune", mesure_le: null, derniere_sauvegarde: null, dernier_export: null, imports_en_cours: 0 });
    expect(j.base).toEqual({ taille_octets: null, quota_octets: 1000, pourcentage_bps: null });
  });

  it("[B-328] le portail reçoit les quotas et l'état des données du seul client de la session", async () => {
    const { app, lus } = serveur(A);
    const r = await app.inject({ method: "GET", url: "/api/portail/v1/donnees" });
    expect(r.statusCode).toBe(200);
    expect(lus).toEqual([A]);
    expect(r.json()).toMatchObject({ palier: "pro", personnes: { nombre: 50, quota: 50 }, base: { quota_octets: 2000 }, imports_en_cours: 2 });
  });

  it("[B-328] le portail applique la surcharge du client et le palier de la config, jamais ceux d'un autre", async () => {
    const { app } = serveur(B);
    const j = (await app.inject({ method: "GET", url: "/api/portail/v1/donnees" })).json();
    expect(j.palier).toBe("etendu");
    expect(j.personnes).toEqual({ nombre: 9, quota: 300, pourcentage_bps: 300 });
  });
});
