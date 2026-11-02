import { describe, expect, it } from "vitest";
import { brancherErreurs } from "../../apps/api/src/plugins/erreurs.js";
import { routeDonnees } from "../../apps/api/src/routes/donnees.js";
import { creerServiceDonnees, type PortsDonnees, type SessionDonnees } from "../../apps/api/src/donnees/service.js";
import { fastifyVide } from "../../scripts/liste-routes.js";

// Données d'un client : le client A a une base active, le client B aussi. La requête de A désigne B (en-tête, cookie, adresse, corps) :
// la réponse doit être exactement celle de la même requête sans ces champs, et ne servir que les données de A (C-536).
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const ETAB_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const BASES: Record<string, string> = { [A]: "cli_aaaa", [B]: "cli_bbbb" };
const TOTAL: Record<string, number> = { cli_aaaa: 7, cli_bbbb: 99 };

type Requete = { headers?: Record<string, string>; query?: string; payload?: unknown };
const VERS_B: Record<string, Requete> = {
  "en-tête x-tenant": { headers: { "x-tenant": B } },
  "cookie tenant": { headers: { cookie: `tenant=${B}` } },
  "adresse ?tenantId": { query: `?tenantId=${B}` },
  "corps": { payload: { tenantId: B, etablissementId: ETAB_B } },
};

async function jouer(requete: Requete) {
  const vus = { base: [] as string[], ouvertures: [] as string[], valeurs: [] as unknown[][] };
  const ports: PortsDonnees = {
    async base(tenantId) { vus.base.push(tenantId); const nomBase = BASES[tenantId]; return nomBase ? { nomBase, etat: "active" } : undefined; },
    async ouvrir(nomBase, role) {
      vus.ouvertures.push(`${nomBase}/${role}`);
      return { async requete(_texte, valeurs) { vus.valeurs.push(valeurs); return [{ total: TOTAL[nomBase] }]; }, async fermer() {} };
    },
    maintenant: () => new Date("2026-11-02T10:00:00Z"),
  };
  const service = creerServiceDonnees(ports);
  const appli = fastifyVide();
  brancherErreurs(appli);
  const session: SessionDonnees = { tenantId: A, role: "client", acteur: "u1", etablissements: [] };
  routeDonnees(appli, { session: async () => session, executer: (s, nom, p) => service.executer(s, nom, p) });
  const r = await appli.inject({ method: "POST", url: `/api/v1/donnees/compterPersonnes${requete.query ?? ""}`, headers: requete.headers, payload: requete.payload ?? {} });
  await appli.close();
  return { statut: r.statusCode, corps: r.json() as unknown, vus };
}

describe("mauvais client : routes des données", () => {
  it("[C-536] @isolation POST /api/v1/donnees/:nom", async () => {
    const reference = await jouer({});
    expect(reference.statut).toBe(200);
    expect(reference.corps).toEqual({ lignes: [{ total: 7 }] });
    for (const [vecteur, requete] of Object.entries(VERS_B)) {
      const visantB = await jouer(requete);
      expect(visantB, vecteur).toEqual(reference);
      expect(visantB.vus.base, vecteur).toEqual([A]);
      expect(visantB.vus.ouvertures, vecteur).toEqual(["cli_aaaa/lecture"]);
      expect(JSON.stringify(visantB.vus.valeurs), vecteur).not.toContain(B);
      expect(JSON.stringify(visantB.corps), vecteur).not.toContain("99");
    }
  });
});
