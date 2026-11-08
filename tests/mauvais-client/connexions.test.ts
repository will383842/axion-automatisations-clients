import { beforeAll, describe, expect, it } from "vitest";
import { ErreurApi, brancherErreurs } from "../../apps/api/src/plugins/erreurs.js";
import { routeLiensConnexions } from "../../apps/api/src/routes/connexions/liens.js";
import { routeRevocationConnexion } from "../../apps/api/src/routes/connexions/revocation.js";
import { fastifyVide } from "../../scripts/liste-routes.js";

// Routes de l'équipe pour relier et révoquer une connexion (T4-42b). L'utilisateur du client A (session de client, pas de rôle équipe) vise une ressource du client B :
// réponse identique à celle d'une ressource absente, AUCUNE dépendance appelée, donc rien de B n'est lu ni révoqué (C-536). Le contrôle est celui de la session, jamais un en-tête.
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const ABSENT = "33333333-3333-4333-8333-333333333333";
const CONNEXION = "44444444-4444-4444-8444-444444444444";
const SESSIONS: Record<string, { role: string; tenantId?: string }> = {
  "sid-client-a": { role: "client", tenantId: A },
  "sid-equipe": { role: "dirigeant" },
};
const ROLES_EQUIPE = new Set(["dirigeant", "second_administrateur"]);
let appels = 0;
const espion = (): never =>
  new Proxy(function () {}, { get: (_c, p) => (p === "then" ? undefined : espion()), apply: () => { appels++; return undefined; } }) as never;
const exigerEquipe = async (requete: { headers: Record<string, unknown> }) => {
  const sid = /(?:^|;\s*)sid=([^;]+)/.exec(String(requete.headers["cookie"] ?? ""))?.[1] ?? "";
  const session = Object.hasOwn(SESSIONS, sid) ? SESSIONS[sid] : undefined;
  if (!session || !ROLES_EQUIPE.has(session.role)) throw new ErreurApi("action_interdite", "Action interdite.");
};
let appli: ReturnType<typeof fastifyVide>;

beforeAll(async () => {
  appli = fastifyVide();
  brancherErreurs(appli);
  routeLiensConnexions(appli, { exigerEquipe: exigerEquipe as never, session: espion(), porte: espion(), nouvelId: espion(), creer: espion(), ecrireCoffre: espion(), emettreLien: espion() });
  routeRevocationConnexion(appli, { exigerEquipe: exigerEquipe as never, session: espion(), revoquer: espion() });
  await appli.ready();
});

async function jouer(url: string, id: string, sid?: string) {
  const avant = appels;
  const r = await appli.inject({ method: "POST", url, headers: sid ? { cookie: `sid=${sid}` } : {}, payload: { motif: "demande_client", tenantId: id } });
  const corps = (r.body ? r.json() : {}) as { erreur?: { id_trace?: string } };
  if (corps.erreur) delete corps.erreur.id_trace;
  return { statut: r.statusCode, corps, appels: appels - avant };
}
async function verifier(chemin: string) {
  const vers = (id: string) => chemin.replace(":connexionId", CONNEXION).replace(":id", id);
  expect(vers(B)).not.toBe(vers(ABSENT));
  const autreClient = await jouer(vers(B), B, "sid-client-a");
  const absente = await jouer(vers(ABSENT), ABSENT, "sid-client-a");
  const sansSession = await jouer(vers(B), B);
  expect(autreClient).toEqual(absente);
  expect(sansSession).toEqual(absente);
  // Témoin : avec une session d'équipe, le contrôle d'équipe est passé (le refus vient bien de la session).
  expect((await jouer(vers(B), B, "sid-equipe")).statut).not.toBe(403);
  return autreClient;
}
const REFUS = { statut: 403, appels: 0, corps: { erreur: { code: "action_interdite", message: "Action interdite." } } };

describe("mauvais client : connexions", () => {
  it("[C-536] @isolation POST /api/console/v1/clients/:id/connexions/liens", async () => expect(await verifier("/api/console/v1/clients/:id/connexions/liens")).toEqual(REFUS));
  it("[C-536] @isolation POST /api/console/v1/clients/:id/connexions/:connexionId/revoquer", async () => expect(await verifier("/api/console/v1/clients/:id/connexions/:connexionId/revoquer")).toEqual(REFUS));
});
