import { describe, expect, it } from "vitest";
import { brancherErreurs } from "../../apps/api/src/plugins/erreurs.js";
import { routeImport } from "../../apps/api/src/routes/import.js";
import { fastifyVide } from "../../scripts/liste-routes.js";

// Import de personnes (T2-47b) : la session est celle du client A. La requête désigne B (en-tête, cookie, adresse) : l'écriture reste dans l'établissement de A.
// Un établissement dans le corps est refusé avant toute ouverture de base (C-536).
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
type Requete = { headers?: Record<string, string>; query?: string; payload?: Record<string, unknown> };
const BASE = { colonnes: ["nom"], lignes: [{ nom: "Bertin" }] };

async function jouer(requete: Requete) {
  const ecrits: unknown[][] = [];
  const ouvertures: string[] = [];
  const appli = fastifyVide();
  brancherErreurs(appli);
  routeImport(appli, {
    ouvert: true,
    session: async () => ({ acteur: "u1", etablissementId: A }),
    ports: (s) => ({
      ouvrir: async () => {
        ouvertures.push(s.etablissementId);
        return { client: { query: async (_t: string, v?: unknown[]) => (ecrits.push(v ?? []), { rows: [], rowCount: 1 }) }, valider: async () => undefined, annuler: async () => undefined };
      },
    }),
  });
  const r = await appli.inject({ method: "POST", url: `/api/v1/import/personnes${requete.query ?? ""}`, headers: requete.headers, payload: { ...BASE, ...requete.payload } });
  await appli.close();
  return { statut: r.statusCode, corps: r.json() as unknown, ecrits, ouvertures };
}

describe("import de personnes : mauvais client", () => {
  it("[C-536] @isolation POST /api/v1/import/personnes : B désigné par en-tête, cookie ou adresse, l'écriture reste dans l'établissement de A", async () => {
    const reference = await jouer({});
    expect(reference.statut).toBe(200);
    expect(reference.ouvertures).toEqual([A]);
    expect(JSON.stringify(reference.ecrits)).toContain(A);
    for (const requete of [{ headers: { "x-tenant": B } }, { headers: { cookie: `tenant=${B}` } }, { query: `?tenantId=${B}&etablissementId=${B}` }]) {
      const vu = await jouer(requete);
      expect(vu).toEqual(reference);
      expect(JSON.stringify(vu.ecrits)).not.toContain(B);
    }
    const corps = await jouer({ payload: { etablissementId: B } });
    expect(corps.statut).toBe(400);
    expect(corps.ouvertures).toEqual([]);
    expect(corps.ecrits).toEqual([]);
  });
});
