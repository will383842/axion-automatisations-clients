import { NextResponse, type NextRequest } from "next/server.js";

// Barrière de confort seulement : elle voit si un cookie de session existe, pas s'il est valide (le magasin vit dans le processus Node,
// pas dans le middleware). La vraie vérification est refaite dans la disposition de l'équipe et dans chaque gestionnaire de route.
const PUBLIC = /^\/(?:connexion|entree|api\/auth|api\/sante)(?:\/|$)/;
const COOKIE = "__Host-session=";

export function middleware(requete: NextRequest): NextResponse {
  const { pathname, search } = requete.nextUrl;
  const entetes = new Headers(requete.headers);
  entetes.set("x-chemin", pathname); // écrase toute valeur envoyée par le navigateur
  if (!PUBLIC.test(pathname) && !requete.headers.get("cookie")?.split(/;\s*/).some((c) => c.startsWith(COOKIE) && c.length > COOKIE.length)) {
    const cible = new URL("/connexion/reconnexion", requete.url);
    cible.searchParams.set("retour", pathname + search);
    return NextResponse.redirect(cible);
  }
  return NextResponse.next({ request: { headers: entetes } });
}

export const config = { matcher: ["/((?!_next/|favicon.ico|.*\\.[a-z0-9]+$).*)"] };
