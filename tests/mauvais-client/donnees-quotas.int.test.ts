import { describe, expect, it } from "vitest";
import { fastifyVide as Fastify } from "../../scripts/liste-routes.js";
import { brancherErreurs } from "../../apps/api/src/plugins/erreurs.js";
import { lireConfigQuotas } from "../../apps/api/src/quotas/paliers.js";
import { CHEMIN_CONSOLE, CHEMIN_PORTAIL, gestionnairesDonneesQuotas, type SourceEtat } from "../../apps/api/src/routes/donnees-quotas.js";

// Quotas et état des données : le client A a ses chiffres, le client B les siens. La requête de A désigne B (en-tête, cookie, adresse, corps) :
// la réponse doit être exactement celle de la même requête sans ces champs, et ne jamais porter un chiffre de B (C-536).
// Ports en mémoire, sans Docker : le fichier suit le nom imposé par la fiche (.int.test.ts) et se lance avec SOCLE_INTEGRATION=1.
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const CONFIG = lireConfigQuotas(JSON.stringify({
  essentiel: { base_octets: 1000, fichiers_octets: 2000, personnes: 100 },
  pro: { base_octets: 2000, fichiers_octets: 4000, personnes: 200 },
  etendu: { base_octets: 3000, fichiers_octets: 6000, personnes: 300 },
}));
const M = new Date("2026-11-02T10:00:00Z");
const SOURCES: Record<string, SourceEtat> = {
  [A]: { palier: "essentiel", surcharge: {}, mesures: { baseOctets: 111, fichiersOctets: 222, personnes: 33, mesureLe: M }, importsEnCours: 1, derniereSauvegarde: null, dernierExport: null },
  [B]: { palier: "etendu", surcharge: { personnes: 98765 }, mesures: { baseOctets: 777777, fichiersOctets: 888888, personnes: 4321, mesureLe: M }, importsEnCours: 55, derniereSauvegarde: null, dernierExport: null },
};
type Requete = { headers?: Record<string, string>; query?: string; payload?: unknown };
const VERS_B: Record<string, Requete> = {
  "en-tête x-tenant": { headers: { "x-tenant": B } },
  "cookie tenant": { headers: { cookie: `tenant=${B}` } },
  "adresse ?tenantId": { query: `?tenantId=${B}&client=${B}` },
  "corps": { payload: { tenantId: B } },
};

async function jouer(requete: Requete) {
  const lus: string[] = [];
  const app = Fastify();
  brancherErreurs(app);
  const g = gestionnairesDonneesQuotas({ config: CONFIG, exigerEquipe: async () => undefined, session: async () => ({ tenantId: A }), async source(t) { lus.push(t); return SOURCES[t]; } });
  app.get(CHEMIN_PORTAIL, g.portail);
  app.get(CHEMIN_CONSOLE, { preHandler: g.exigerEquipe }, g.console);
  const r = await app.inject({ method: "GET", url: `/api/portail/v1/donnees${requete.query ?? ""}`, headers: requete.headers, payload: requete.payload as never });
  await app.close();
  return { statut: r.statusCode, corps: r.json() as unknown, lus };
}

describe("mauvais client : quotas et état des données", () => {
  it("[C-536] @isolation GET /api/portail/v1/donnees", async () => {
    const reference = await jouer({});
    expect(reference.statut).toBe(200);
    expect(reference.lus).toEqual([A]);
    for (const [vecteur, requete] of Object.entries(VERS_B)) {
      const visantB = await jouer(requete);
      expect(visantB, vecteur).toEqual(reference);
      expect(JSON.stringify(visantB.corps), vecteur).not.toMatch(/777777|888888|4321|98765|"imports_en_cours":55|etendu/);
    }
  });

  it("[C-536] @isolation GET /api/console/v1/clients/:id/donnees", async () => {
    // La console lit le client de l'URL (équipe) : un identifiant inconnu et un identifiant d'un autre client absent de la source donnent la même réponse.
    const app = Fastify();
    brancherErreurs(app);
    const g = gestionnairesDonneesQuotas({ config: CONFIG, exigerEquipe: async () => undefined, session: async () => ({ tenantId: A }), source: async (t) => (t === A ? SOURCES[A] : undefined) });
    app.get(CHEMIN_CONSOLE, { preHandler: g.exigerEquipe }, g.console);
    const absent = await app.inject({ method: "GET", url: "/api/console/v1/clients/33333333-3333-4333-8333-333333333333/donnees" });
    const autre = await app.inject({ method: "GET", url: `/api/console/v1/clients/${B}/donnees` });
    expect(absent.statusCode).toBe(404);
    expect(autre.statusCode).toBe(absent.statusCode);
    expect({ ...autre.json().erreur, id_trace: 0 }).toEqual({ ...absent.json().erreur, id_trace: 0 });
    expect(JSON.stringify(autre.json())).not.toMatch(/777777|4321/);
    await app.close();
  });
});
