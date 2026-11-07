import { createRequire } from "node:module";
import ts from "typescript";
import { brancherErreurs } from "../apps/api/src/plugins/erreurs.js";
import { BRANCHEMENTS } from "../apps/api/src/routes/registre-branchements.js";

// Liste des routes de l'API (C-536) : l'application Fastify est construite SANS listen et SANS base, avec des dépendances vides ; seul le tableau des routes sort.
// Une route s'inscrit par un fichier neuf dans apps/api/src/routes/branchements/ (ADR 0139), jamais ici.
// Une route absente de la liste est vue par la garde (scripts/garde-mauvais-client.test.ts), qui compte aussi les enregistrements dans le code source.
export interface RouteListee {
  methode: string;
  chemin: string;
}
type Appli = Parameters<(typeof BRANCHEMENTS)[number]["lister"]>[0];

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

export async function listerRoutes(): Promise<RouteListee[]> {
  const appli = fastify();
  const vues = new Map<string, RouteListee>();
  appli.addHook("onRoute", (r) => {
    // HEAD est ajoutée par Fastify à chaque GET ; OPTIONS n'est jamais déclarée par l'API.
    for (const m of [r.method].flat()) if (m !== "HEAD" && m !== "OPTIONS") vues.set(`${m} ${r.url}`, { methode: m, chemin: r.url });
  });
  brancherErreurs(appli);
  for (const b of BRANCHEMENTS) b.lister(appli);
  await appli.ready();
  await appli.close();
  return [...vues.values()].sort((a, b) => `${a.chemin} ${a.methode}`.localeCompare(`${b.chemin} ${b.methode}`));
}
