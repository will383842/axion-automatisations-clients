import { NextResponse, type NextRequest } from "next/server.js";
import { genererNonce } from "../../../packages/securite-web/src/csp.ts";
import { appliquerEntetes, entetesSecurite } from "../../../packages/securite-web/src/entetes.ts";

// Barrière de confort seulement : elle voit si un cookie de session existe, pas s'il est valide (le magasin vit dans le processus Node).
// La vraie vérification est refaite dans chaque gestionnaire. Dette E2 : Next 16 déprécie « middleware » au profit de « proxy » (voir ADR 0132).
const PUBLIC = /^\/(?:api\/auth|api\/sante)(?:\/|$)/;
const SURES = new Set(["GET", "HEAD", "OPTIONS"]);
const COOKIE = "__Host-session=";

// Origine publique du portail (PORTAIL_ORIGINE, même variable que auth/configuration.ts), jamais l'adresse interne de Next (nextUrl.origin).
// Absente ou invalide (pas du HTTPS sans chemin ni paramètre) : null, donc refus de tout geste.
function originePublique(): string | null {
  try {
    const u = new URL(process.env["PORTAIL_ORIGINE"] ?? "");
    return u.protocol === "https:" && u.pathname === "/" && !u.search && !u.hash ? u.origin : null;
  } catch {
    return null;
  }
}

export function middleware(requete: NextRequest): NextResponse {
  const { pathname, search } = requete.nextUrl;
  // Un nonce neuf par réponse (C-681) ; la CSP part aussi vers la page. Toute réponse, refus et redirections compris, porte les en-têtes.
  const nonce = genererNonce();
  const securite = entetesSecurite(nonce);
  const finir = (r: NextResponse): NextResponse => {
    appliquerEntetes(r.headers, nonce);
    return r;
  };
  const attendue = originePublique();
  if (!SURES.has(requete.method) && (attendue === null || requete.headers.get("origin") !== attendue)) {
    return finir(NextResponse.json({ erreur: { code: "action_interdite", message: "Action non permise.", id_trace: crypto.randomUUID() } }, { status: 403 }));
  }
  const entetes = new Headers(requete.headers);
  entetes.set("x-chemin", pathname); // écrase toute valeur envoyée par le navigateur
  entetes.set("content-security-policy", securite["content-security-policy"]!);
  if (!PUBLIC.test(pathname) && !requete.headers.get("cookie")?.split(/;\s*/).some((c) => c.startsWith(COOKIE) && c.length > COOKIE.length)) {
    const cible = new URL("/api/auth/connexion", attendue ?? requete.url);
    cible.searchParams.set("retour", pathname + search);
    return finir(NextResponse.redirect(cible));
  }
  return finir(NextResponse.next({ request: { headers: entetes } }));
}

export const config = { matcher: ["/((?!_next/|favicon.ico|.*\\.[a-z0-9]+$).*)"] };
