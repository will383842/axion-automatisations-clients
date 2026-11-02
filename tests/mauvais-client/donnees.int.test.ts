import { describe, expect, it } from "vitest";
import { brancherErreurs } from "../../apps/api/src/plugins/erreurs.js";
import { routeDonnees } from "../../apps/api/src/routes/donnees.js";
import { creerServiceDonnees, type PortsDonnees, type SessionDonnees } from "../../apps/api/src/donnees/service.js";
import { fastifyVide } from "../../scripts/liste-routes.js";

// Données d'un client : l'utilisateur du client A vise le client B. La réponse doit être EXACTEMENT celle d'une ressource absente :
// même statut, même corps (hors identifiant de trace), même nombre de requêtes aux ports (C-536).
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const ETAB_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

async function jouer(basesActives: string[]) {
  const compte = { base: 0, ouvrir: 0, requete: 0 };
  const ports: PortsDonnees = {
    async base(tenantId) { compte.base++; return basesActives.includes(tenantId) ? { nomBase: `cli_${tenantId.slice(0, 4)}`, etat: "active" } : undefined; },
    async ouvrir() { compte.ouvrir++; return { async requete() { compte.requete++; return [{ total: 7 }]; }, async fermer() {} }; },
    maintenant: () => new Date("2026-11-02T10:00:00Z"),
  };
  const service = creerServiceDonnees(ports);
  const appli = fastifyVide();
  brancherErreurs(appli);
  // Session du client A (sans base propre dans ce scénario) ; la requête désigne B partout où un client peut l'écrire.
  const session: SessionDonnees = { tenantId: A, role: "client", acteur: "u1", etablissements: [] };
  routeDonnees(appli, { session: async () => session, executer: (s, nom, p) => service.executer(s, nom, p) });
  const r = await appli.inject({ method: "POST", url: `/api/v1/donnees/compterPersonnes?tenantId=${B}`, headers: { "x-tenant": B, cookie: `tenant=${B}` }, payload: { tenantId: B, etablissementId: ETAB_B } });
  await appli.close();
  const corps = r.json() as { erreur?: { id_trace?: string } };
  if (corps.erreur) delete corps.erreur.id_trace;
  return { statut: r.statusCode, corps, compte };
}

describe("mauvais client : routes des données", () => {
  it("[C-536] @isolation POST /api/v1/donnees/:nom", async () => {
    const absente = await jouer([]);
    const autreClient = await jouer([B]);
    expect(autreClient).toEqual(absente);
    expect(autreClient.statut).toBe(404);
    expect(autreClient.corps).toEqual({ erreur: { code: "introuvable", message: "Ressource introuvable." } });
    expect(autreClient.compte).toEqual({ base: 1, ouvrir: 0, requete: 0 });
  });
});
