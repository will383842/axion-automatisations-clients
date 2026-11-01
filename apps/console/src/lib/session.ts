import { randomBytes } from "node:crypto";

// Sessions et transactions de connexion gardées côté serveur (en mémoire du processus). Le navigateur ne reçoit qu'un identifiant opaque.
const DUREE_SESSION = 8 * 3600 * 1000; // borne de la session Keycloak de l'équipe
const DUREE_TRANSACTION = 10 * 60 * 1000;
export const COOKIE_SESSION = "__Host-session";
export const COOKIE_TRANSACTION = "__Host-transaction";

export interface Session { id: string; sub: string; email: string; jeton: string; expireA: number }
const MAX_TRANSACTIONS = 10_000; // une requête anonyme crée une transaction : plafond contre la saturation de la mémoire
interface Transaction { verifier: string; nonce: string; retour: string }
const aleatoire = () => randomBytes(32).toString("base64url");

export function creerMagasin(maintenant: () => number = Date.now) {
  const sessions = new Map<string, Session>();
  const transactions = new Map<string, Transaction & { expireA: number }>();
  const purger = () => {
    for (const [k, s] of sessions) if (s.expireA <= maintenant()) sessions.delete(k);
    for (const [k, t] of transactions) if (t.expireA <= maintenant()) transactions.delete(k);
  };
  return {
    ouvrirTransaction(t: Transaction): string | undefined {
      purger();
      if (transactions.size >= MAX_TRANSACTIONS) return undefined;
      const etat = aleatoire();
      transactions.set(etat, { ...t, expireA: maintenant() + DUREE_TRANSACTION });
      return etat;
    },
    consommerTransaction(etat: string): Transaction | undefined {
      const t = transactions.get(etat);
      transactions.delete(etat);
      if (!t || t.expireA <= maintenant()) return undefined;
      return { verifier: t.verifier, nonce: t.nonce, retour: t.retour };
    },
    // La durée est celle de la session Keycloak de l'équipe (8 h), jamais l'expiration du jeton d'identité (5 min).
    ouvrirSession(s: Omit<Session, "id" | "expireA">): Session {
      purger();
      const session = { ...s, id: aleatoire(), expireA: maintenant() + DUREE_SESSION };
      sessions.set(session.id, session);
      return session;
    },
    lireSession(id: string): Session | undefined {
      const s = sessions.get(id);
      if (s && s.expireA <= maintenant()) sessions.delete(id);
      return sessions.get(id);
    },
    fermerSession(id: string): void {
      sessions.delete(id);
    },
  };
}
// Ancré sur globalThis : les routes sont des entrées séparées du paquet Next.js et doivent voir le même magasin.
const CLE = Symbol.for("axion.console.magasin");
export const magasin: ReturnType<typeof creerMagasin> = ((globalThis as Record<symbol, unknown>)[CLE] ??= creerMagasin()) as ReturnType<typeof creerMagasin>;

const BASE = "Path=/; Secure; HttpOnly";
export const cookieSession = (id: string, secondes: number) => `${COOKIE_SESSION}=${id}; ${BASE}; SameSite=Strict; Max-Age=${secondes}`;
// Lax : Keycloak ramène le navigateur depuis un autre site ; un cookie Strict ne partirait pas. Il ne vit que 10 minutes.
export const cookieTransaction = (etat: string) => `${COOKIE_TRANSACTION}=${etat}; ${BASE}; SameSite=Lax; Max-Age=600`;
export const cookieEffacer = (nom: string) => `${nom}=; ${BASE}; SameSite=${nom === COOKIE_SESSION ? "Strict" : "Lax"}; Max-Age=0`;

export function lireCookie(entete: string | null, nom: string): string | undefined {
  return entete?.split(/;\s*/).map((c) => c.split(/=(.*)/s)).find(([k]) => k === nom)?.[1] || undefined;
}

// Chaque gestionnaire de route revérifie la session lui-même : le proxy de Next.js ne suffit pas.
export function sessionDe(requete: Request): Session | undefined {
  const id = lireCookie(requete.headers.get("cookie"), COOKIE_SESSION);
  return id ? magasin.lireSession(id) : undefined;
}
