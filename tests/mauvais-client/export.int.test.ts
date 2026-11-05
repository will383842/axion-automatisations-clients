import { describe, expect, it } from "vitest";
import { fastifyVide as Fastify } from "../../scripts/liste-routes.js";
import { creerServiceExport, dateExpiration, type EntreeRegistre } from "../../apps/api/src/export/exporter.js";
import { brancherErreurs } from "../../apps/api/src/plugins/erreurs.js";
import { CHEMIN_PORTAIL, gestionnairesExport } from "../../apps/api/src/routes/export.js";

// Export : l'export de B existe, la session est celle de A. Quoi que la requête de A désigne (demande de B, en-tête, cookie, adresse, corps),
// la réponse est celle d'un export absent, et aucun lien n'est signé pour B (C-536). Ports en mémoire ; nom .int.test.ts imposé par la fiche.
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const DB = "55555555-5555-4555-8555-555555555555";
const T0 = new Date("2026-11-02T10:00:00Z");
const ENTREES: EntreeRegistre[] = [{ tenantId: B, demande: DB, cle: `exports/${DB}.zip`, expireLe: dateExpiration(T0), retire: false }];

async function jouer(url: string, entetes: Record<string, string> = {}) {
  const liens: string[] = [];
  const app = Fastify();
  brancherErreurs(app);
  const service = creerServiceExport({
    registre: { trouver: async (t, d) => ENTREES.find((e) => e.tenantId === t && (d === undefined || e.demande === d)), expires: async () => [], marquerRetire: async () => undefined },
    file: { ajouter: async () => undefined },
    lien: async (t, cle) => { liens.push(`${t}:${cle}`); return "https://stockage.test/lien"; },
    retirerObjet: async () => undefined,
    gel: { gelActif: async () => false },
    retraitActif: false,
    tracer: async () => undefined,
    maintenant: () => T0,
    nouvelleDemande: () => DB,
  });
  const g = gestionnairesExport({ service, exigerEquipe: async () => undefined, exigerReauth: async () => undefined, session: async () => ({ tenantId: A }), acteurEquipe: () => "equipe:u1" });
  app.get(CHEMIN_PORTAIL, g.lire);
  const r = await app.inject({ method: "GET", url, headers: entetes });
  await app.close();
  return { statut: r.statusCode, corps: JSON.stringify(r.json()), liens };
}

describe("mauvais client : export", () => {
  it("[C-536] @isolation GET /api/portail/v1/export", async () => {
    const reference = await jouer(CHEMIN_PORTAIL);
    expect(reference.statut).toBe(404);
    const visees = [
      await jouer(`${CHEMIN_PORTAIL}?demande=${DB}`),
      await jouer(`${CHEMIN_PORTAIL}?demande=${DB}&tenantId=${B}`),
      await jouer(CHEMIN_PORTAIL, { "x-tenant": B }),
      await jouer(CHEMIN_PORTAIL, { cookie: `tenant=${B}` }),
    ];
    for (const v of visees) {
      expect(v.statut).toBe(404);
      expect(v.liens).toEqual([]);
      expect(v.corps).not.toMatch(new RegExp(`${DB}|${B}|stockage.test`));
    }
  });
});
