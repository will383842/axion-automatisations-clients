import { createRequire } from "node:module";
import ts from "typescript";
import { brancherErreurs } from "../apps/api/src/plugins/erreurs.js";
import { routeATrancher } from "../apps/api/src/routes/a-trancher.js";
import { routeFiche } from "../apps/api/src/routes/clients/fiche.js";
import { routeNotes } from "../apps/api/src/routes/clients/notes.js";
import { routeRecherche } from "../apps/api/src/routes/recherche.js";
import { routeCanaux } from "../apps/api/src/routes/canaux.js";
import { routeImportCatalogue } from "../apps/api/src/routes/catalogue/import.js";
import { routeVersionsCatalogue } from "../apps/api/src/routes/catalogue/versions.js";
import { routeDeploiementInstances } from "../apps/api/src/routes/instances/deploiement.js";
import { routeCrm } from "../apps/api/src/routes/crm.js";
import { routeDonnees } from "../apps/api/src/routes/donnees.js";
import { routeDonneesModule } from "../apps/api/src/routes/portail/donnees-module.js";
import { routeExecuteur } from "../apps/api/src/routes/executeur/index.js";
import { routeEntree } from "../apps/api/src/routes/entree.js";
import { routeImport } from "../apps/api/src/routes/import.js";
import { routeGel } from "../apps/api/src/routes/gel.js";
import { brancherHub } from "../apps/api/src/routes/hub.js";
import { routeAnnulation, routeJournal } from "../apps/api/src/routes/journal.js";
import { routeProvisionnement } from "../apps/api/src/routes/provisionnement.js";
import { routeReglages } from "../apps/api/src/routes/reglages.js";
import { routeSante } from "../apps/api/src/routes/sante.js";
import { routeWebhooks } from "../apps/api/src/routes/webhooks/entree.js";

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
  "POST /api/catalogue/v1/versions": "Import d'une version (T4-25) : réservé à l'équipe ou au poste de la recette signé, catalogue commun sans donnée de client, interrupteur IMPORT_OUVERT fermé par défaut.",
  "POST /api/catalogue/v1/versions/:id/passages": "Passage d'état d'une version (T4-27b) : réservé à l'équipe, catalogue commun sans donnée de client, route fermée (503) par défaut.",
  "POST /api/catalogue/v1/versions/:id/preuves": "Preuve d'une étape de la procédure (T4-27b) : réservé à l'équipe, catalogue commun sans donnée de client, route fermée (503) par défaut.",
};
const DECLARATION = /\[C-536\] @isolation (GET|POST|PUT|PATCH|DELETE) (\/[^\s"'`]*)/g;

const MODES_SAUTES = new Set(["skip", "todo", "skipIf", "runIf", "fails"]);
const SUITES = new Set(["describe", "suite", "it", "test"]);
const contientExpect = (noeud: ts.Node): boolean =>
  (ts.isCallExpression(noeud) && ts.isIdentifier(noeud.expression) && noeud.expression.text === "expect") || ts.forEachChild(noeud, contientExpect) === true;

// Les routes déclarées par les textes de tests : le titre d'un vrai it()/test() « [C-536] @isolation <MÉTHODE> <chemin> », ni sauté ni à écrire,
// dont le corps contient au moins un expect(. Un commentaire, une chaîne isolée, it.skip, it.todo ou un test sans assertion ne déclarent rien.
export function testsDeclares(textes: string[]): Set<string> {
  const trouvees = new Set<string>();
  const visiter = (noeud: ts.Node): void => {
    if (ts.isCallExpression(noeud)) {
      const appele = noeud.expression;
      if (ts.isPropertyAccessExpression(appele) && ts.isIdentifier(appele.expression) && SUITES.has(appele.expression.text) && MODES_SAUTES.has(appele.name.text)) return;
      const [titre, corps] = noeud.arguments;
      if (ts.isIdentifier(appele) && (appele.text === "it" || appele.text === "test") && titre && (ts.isStringLiteral(titre) || ts.isNoSubstitutionTemplateLiteral(titre))
        && corps && (ts.isArrowFunction(corps) || ts.isFunctionExpression(corps)) && contientExpect(corps.body)) {
        for (const m of titre.text.matchAll(DECLARATION)) trouvees.add(`${m[1]} ${m[2]}`);
      }
    }
    ts.forEachChild(noeud, visiter);
  };
  for (const texte of textes) visiter(ts.createSourceFile("essai.ts", texte, ts.ScriptTarget.Latest, true));
  return trouvees;
}

// Nombre d'enregistrements de routes dans un texte de code : receveurs habituels (serveur, appli, app, fastify, s, instance) avec n'importe quel premier argument,
// tout autre receveur dont le premier argument est un chemin, et .route(. Un écart avec la liste fait échouer la garde ; il se corrige à la main.
const METHODES = "get|post|put|patch|delete|head|options|all";
const FORMES = [
  new RegExp(`\\b(?:serveur|appli|app|fastify|instance|s)\\.(?:${METHODES})(?:<[^(]*?>)?\\(`, "g"),
  new RegExp(`\\b\\w+\\.(?:${METHODES})(?:<[^(]*?>)?\\(\\s*[\`"'](?:/|\\$\\{)`, "g"),
  /\b\w+\.route(?:<[^(]*?>)?\(/g,
];
export function compterEnregistrements(source: string): number {
  return new Set(FORMES.flatMap((f) => [...source.matchAll(f)].map((m) => m.index))).size;
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
  routeDonneesModule(appli, rien);
  routeGel(appli, { exigerEquipe: garde, exigerReauthentification: garde, session: rien, gel: rien });
  routeATrancher(appli, { exigerEquipe: garde, appelant: rien, reauthentifie: rien, appliquer: rien, ecarter: rien });
  routeCanaux(appli, { exigerEquipe: garde, magasin: rien });
  routeJournal(appli, { exigerEquipe: garde, lire: rien });
  routeAnnulation(appli, { exigerEquipe: garde, contexte: rien, annuler: rien });
  routeProvisionnement(appli, { exigerEquipe: garde, etatBase: rien, reprendre: rien });
  routeReglages(appli, { exigerEquipe: garde, contexte: rien, historique: rien, modifier: rien, revenir: rien });
  routeFiche(appli, { ouvert: () => false, exigerEquipe: garde, session: rien, lire: rien });
  routeNotes(appli, { ouvert: () => false, exigerEquipe: garde, session: rien, lister: rien, ajouter: rien, epingler: rien, noterAppelEtClore: rien });
  routeRecherche(appli, { ouvert: () => false, exigerEquipe: garde, membre: rien, depot: rien, debit: { parMembre: 1, fenetreMs: 1 } });
  routeEntree(appli, { cles: rien, memoire: rien, alertes: rien, connexionNormale: "/connexion" });
  const entrant = { cles: rien, memoire: rien, actif: () => false };
  brancherHub(appli, { entrant, recepteur: { alerter: () => undefined } as never });
  routeCrm(appli, { entrant, recepteur: rien, file: rien });
  routeImport(appli, { ouvert: false, session: rien, ports: rien });
  routeImportCatalogue(appli, { ouvert: false, importeur: rien, authentifier: garde as never });
  routeVersionsCatalogue(appli, { ouvert: false, cycle: rien, authentifier: garde as never });
  routeDeploiementInstances(appli, { ouvert: false, authentifier: garde as never, creer: rien, tester: rien, activer: rien });
  routeExecuteur(appli, { actif: () => false, cles: rien, memoire: rien, depot: rien, evenements: { depot: rien } });
  routeWebhooks(appli, { actif: () => false, depot: rien, secret: rien, instance: rien, memoire: rien, file: rien, sceller: rien, debit: { parWebhook: 1, global: 1, fenetreMs: 1 } });
  await appli.ready();
  await appli.close();
  return [...vues.values()].sort((a, b) => `${a.chemin} ${a.methode}`.localeCompare(`${b.chemin} ${b.methode}`));
}
