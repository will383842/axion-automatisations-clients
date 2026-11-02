import { createRequire } from "node:module";
import { brancherErreurs } from "../apps/api/src/plugins/erreurs.js";
import { routeATrancher } from "../apps/api/src/routes/a-trancher.js";
import { routeCanaux } from "../apps/api/src/routes/canaux.js";
import { routeCrm } from "../apps/api/src/routes/crm.js";
import { routeDonnees } from "../apps/api/src/routes/donnees.js";
import { routeEntree } from "../apps/api/src/routes/entree.js";
import { routeGel } from "../apps/api/src/routes/gel.js";
import { brancherHub } from "../apps/api/src/routes/hub.js";
import { routeAnnulation, routeJournal } from "../apps/api/src/routes/journal.js";
import { routeProvisionnement } from "../apps/api/src/routes/provisionnement.js";
import { routeReglages } from "../apps/api/src/routes/reglages.js";
import { routeSante } from "../apps/api/src/routes/sante.js";

// Liste des routes de l'API (C-536) : l'application Fastify est construite SANS listen et SANS base, avec des dépendances vides ; seul le tableau des routes sort.
// Une route absente d'ici est vue par la garde (scripts/garde-mauvais-client.test.ts), qui compte aussi les enregistrements dans le code source.
export interface RouteListee {
  methode: string;
  chemin: string;
}
type Appli = Parameters<typeof routeSante>[0];

// Le paquet fastify n'appartient qu'à apps/api : on le charge depuis là, comme le ferait l'API.
const fastify = createRequire(new URL("../apps/api/package.json", import.meta.url))("fastify") as () => Appli & { ready(): Promise<unknown>; close(): Promise<unknown> };
// Application vide, sans listen : sert aussi aux tests de tests/mauvais-client/.
export const fastifyVide = fastify;

// Liste FERMÉE des routes qui ne prennent aucune donnée d'un client, avec la raison. Toute autre route doit avoir son test « mauvais client ».
export const EXEMPTEES: Readonly<Record<string, string>> = {
  "GET /sante": "Santé : aucune donnée de client, réponse fixe.",
  "GET /sante/pret": "Santé : ne lit que le rôle de la connexion, aucune donnée de client.",
  "POST /api/console/v1/entree": "Entrée C6 : jeton signé dans le corps, réponse toujours la même adresse de connexion.",
  "POST /api/hub/v1/faits": "Réception du canal Hub : signature vérifiée, interrupteur fermé par défaut, aucun utilisateur de client.",
  "POST /api/crm/v1/evenements": "Réception du canal CRM : signature vérifiée, interrupteur fermé par défaut, aucun utilisateur de client.",
};
const DECLARATION = /\[C-536\] @isolation (GET|POST|PUT|PATCH|DELETE) (\/[^\s"'`]*)/g;

// Les routes déclarées par les textes de tests (« [C-536] @isolation <MÉTHODE> <chemin> »).
export function testsDeclares(textes: string[]): Set<string> {
  return new Set(textes.flatMap((t) => [...t.matchAll(DECLARATION)].map((m) => `${m[1]} ${m[2]}`)));
}
export function routesSansTest(routes: RouteListee[], declares: Set<string>): string[] {
  return routes
    .map((r) => `${r.methode} ${r.chemin}`)
    .filter((r) => !declares.has(r) && !Object.hasOwn(EXEMPTEES, r))
    .map((r) => `${r} : aucun test « [C-536] @isolation ${r} »`);
}

const rien = {} as never;
const garde = (async () => undefined) as never;

export async function listerRoutes(): Promise<RouteListee[]> {
  const appli = fastify();
  const vues = new Map<string, RouteListee>();
  appli.addHook("onRoute", (r) => {
    // HEAD est ajoutée par Fastify à chaque GET ; OPTIONS n'est jamais déclarée par l'API.
    for (const m of [r.method].flat()) if (m !== "HEAD" && m !== "OPTIONS") vues.set(`${m} ${r.url}`, { methode: m, chemin: r.url });
  });
  brancherErreurs(appli);
  routeSante(appli);
  routeDonnees(appli, rien);
  routeGel(appli, { exigerEquipe: garde, exigerReauthentification: garde, session: rien, gel: rien });
  routeATrancher(appli, { exigerEquipe: garde, appelant: rien, reauthentifie: rien, appliquer: rien, ecarter: rien });
  routeCanaux(appli, { exigerEquipe: garde, magasin: rien });
  routeJournal(appli, { exigerEquipe: garde, lire: rien });
  routeAnnulation(appli, { exigerEquipe: garde, contexte: rien, annuler: rien });
  routeProvisionnement(appli, { exigerEquipe: garde, etatBase: rien, reprendre: rien });
  routeReglages(appli, { exigerEquipe: garde, contexte: rien, historique: rien, modifier: rien, revenir: rien });
  routeEntree(appli, { cles: rien, memoire: rien, alertes: rien, connexionNormale: "/connexion" });
  const entrant = { cles: rien, memoire: rien, actif: () => false };
  brancherHub(appli, { entrant, recepteur: { alerter: () => undefined } as never });
  routeCrm(appli, { entrant, recepteur: rien, file: rien });
  await appli.ready();
  await appli.close();
  return [...vues.values()].sort((a, b) => `${a.chemin} ${a.methode}`.localeCompare(`${b.chemin} ${b.methode}`));
}
