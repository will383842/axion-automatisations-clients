import { NextResponse, type NextRequest } from "next/server.js";
import { genererNonce } from "../../../packages/securite-web/src/csp.ts";
import { appliquerEntetes, entetesSecurite } from "../../../packages/securite-web/src/entetes.ts";

// Barrière de confort seulement : elle voit si un cookie de session existe, pas s'il est valide (le magasin vit dans le processus Node,
// pas dans le middleware). La vraie vérification est refaite dans la disposition de l'équipe et dans chaque gestionnaire de route.
const PUBLIC = /^\/(?:connexion|entree|api\/auth|api\/sante|api\/console\/v1\/entree)(?:\/|$)/;
// L'entrée par lien signé reçoit un POST venu d'un autre site : sa signature tient lieu de contrôle d'origine (C-681).
const SANS_ORIGINE = /^\/(?:entree|api\/console\/v1\/entree)(?:\/|$)/;
const SURES = new Set(["GET", "HEAD", "OPTIONS"]);
const COOKIE = "__Host-session=";

// Origine publique de la console (CONSOLE_ORIGINE, même variable que lib/configuration.ts), jamais l'adresse interne de Next (nextUrl.origin).
// Absente ou invalide (pas du HTTPS sans chemin ni paramètre) : null, donc refus de tout geste.
function originePublique(): string | null {
  try {
    const u = new URL(process.env["CONSOLE_ORIGINE"] ?? "");
    return u.protocol === "https:" && u.pathname === "/" && !u.search && !u.hash ? u.origin : null;
  } catch {
    return null;
  }
}

export function middleware(requete: NextRequest): NextResponse {
  const { pathname, search } = requete.nextUrl;
  // Un nonce neuf par réponse (C-681) ; la CSP part aussi vers la page, qui en tire le nonce de ses scripts. Toute réponse, refus et redirections compris, porte les en-têtes.
  const nonce = genererNonce();
  const securite = entetesSecurite(nonce);
  const finir = (r: NextResponse): NextResponse => {
    appliquerEntetes(r.headers, nonce);
    return r;
  };
  // Geste qui change quelque chose : l'origine doit être celle de la console, avant toute page. Le jeton CSRF lié à la session est vérifié par les gestionnaires (csrf.ts).
  const attendue = originePublique();
  if (!SURES.has(requete.method) && !SANS_ORIGINE.test(pathname) && (attendue === null || requete.headers.get("origin") !== attendue)) {
    return finir(NextResponse.json({ erreur: { code: "action_interdite", message: "Action non permise.", id_trace: crypto.randomUUID() } }, { status: 403 }));
  }
  const entetes = new Headers(requete.headers);
  entetes.set("x-chemin", pathname); // écrase toute valeur envoyée par le navigateur
  entetes.set("content-security-policy", securite["content-security-policy"]!);
  if (!PUBLIC.test(pathname) && !requete.headers.get("cookie")?.split(/;\s*/).some((c) => c.startsWith(COOKIE) && c.length > COOKIE.length)) {
    const cible = new URL("/connexion/reconnexion", requete.url);
    cible.searchParams.set("retour", pathname + search);
    return finir(NextResponse.redirect(cible));
  }
  return finir(NextResponse.next({ request: { headers: entetes } }));
}

export const config = { matcher: ["/((?!_next/|favicon.ico|.*\\.[a-z0-9]+$).*)"] };
