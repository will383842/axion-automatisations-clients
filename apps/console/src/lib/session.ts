import { randomBytes } from "node:crypto";

// Sessions et transactions de connexion gardées côté serveur (en mémoire du processus). Le navigateur ne reçoit qu'un identifiant opaque.
// La durée de la session ne vient JAMAIS de l'exp du jeton d'identité (5 min) : elle suit la session Keycloak de l'équipe.
export const DUREE_SESSION = 8 * 3600 * 1000; // ssoSessionMaxLifespan
const INACTIVITE_SESSION = 30 * 60 * 1000; // ssoSessionIdleTimeout
export const PLAFOND_TRANSACTIONS = 10_000; // mémoire alimentée sans authentification : plafonnée
const DUREE_TRANSACTION = 10 * 60 * 1000;
export const COOKIE_SESSION = "__Host-session";
export const COOKIE_TRANSACTION = "__Host-transaction";

export interface Session { id: string; sub: string; email?: string | undefined; jeton: string; expireA: number; activiteA: number }
interface Transaction { verifier: string; nonce: string; retour: string }
const aleatoire = () => randomBytes(32).toString("base64url");

export function creerMagasin(maintenant: () => number = () => Date.now(), plafond: number = PLAFOND_TRANSACTIONS) {
  const sessions = new Map<string, Session>();
  const transactions = new Map<string, Transaction & { expireA: number }>();
  const vivante = (s: Session) => s.expireA > maintenant() && s.activiteA + INACTIVITE_SESSION > maintenant();
  const purger = () => {
    for (const [k, s] of sessions) if (!vivante(s)) sessions.delete(k);
    for (const [k, t] of transactions) if (t.expireA <= maintenant()) transactions.delete(k);
  };
  return {
    ouvrirTransaction(t: Transaction): string | undefined {
      purger();
      if (transactions.size >= plafond) return undefined;
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
    ouvrirSession(s: Pick<Session, "sub" | "email" | "jeton">): Session {
      purger();
      const session: Session = { ...s, id: aleatoire(), expireA: maintenant() + DUREE_SESSION, activiteA: maintenant() };
      sessions.set(session.id, session);
      return session;
    },
    lireSession(id: string): Session | undefined {
      const s = sessions.get(id);
      if (!s) return undefined;
      if (!vivante(s)) {
        sessions.delete(id);
        return undefined;
      }
      s.activiteA = maintenant();
      return s;
    },
    fermerSession(id: string): void {
      sessions.delete(id);
    },
  };
}
// Ancré sur globalThis : /connexion et /api/auth/rappel sont deux entrées du bundle Next.js, le module peut être chargé deux fois.
const CLE_MAGASIN = Symbol.for("axion.console.magasin");
const global = globalThis as unknown as Record<symbol, ReturnType<typeof creerMagasin> | undefined>;
export const magasin = (global[CLE_MAGASIN] ??= creerMagasin());

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
