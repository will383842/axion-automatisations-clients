import { randomBytes } from "node:crypto";
import type { RoleClient } from "./connexion.ts";

// Sessions et transactions de connexion gardées côté serveur (en mémoire du processus). Le navigateur ne reçoit qu'un identifiant opaque ;
// les jetons (identité, accès, rafraîchissement) ne lui sont JAMAIS envoyés. Magasin partagé et session de 30 jours : T6-04.
export const DUREE_SESSION = 8 * 3600 * 1000; // ssoSessionMaxLifespan
const INACTIVITE_SESSION = 30 * 60 * 1000; // ssoSessionIdleTimeout
export const PLAFOND_TRANSACTIONS = 10_000; // mémoire alimentée sans authentification : plafonnée
const DUREE_TRANSACTION = 10 * 60 * 1000;
const MARGE_ACCES = 30_000; // on rafraîchit un peu avant l'expiration
export const COOKIE_SESSION = "__Host-session";
export const COOKIE_TRANSACTION = "__Host-transaction";

export interface Identite { sub: string; role: RoleClient; organisation: string }
export interface Jetons { jetonIdentite: string; jetonAcces: string; jetonRafraichissement: string; accesExpireA: number }
export interface Session extends Identite, Jetons { id: string; expireA: number; activiteA: number }
export interface Renouvele { jetonAcces: string; jetonRafraichissement: string; expireDans: number }
interface Transaction { verifier: string; nonce: string; retour: string }
const aleatoire = () => randomBytes(32).toString("base64url");

export function creerMagasin(maintenant: () => number = () => Date.now(), plafond: number = PLAFOND_TRANSACTIONS) {
  const sessions = new Map<string, Session>();
  const transactions = new Map<string, Transaction & { expireA: number }>();
  const enVol = new Map<string, Promise<string | undefined>>();
  const vivante = (s: Session) => s.expireA > maintenant() && s.activiteA + INACTIVITE_SESSION > maintenant();
  const purger = () => {
    for (const [k, s] of sessions) if (!vivante(s)) sessions.delete(k);
    for (const [k, t] of transactions) if (t.expireA <= maintenant()) transactions.delete(k);
  };
  const magasin = {
    ouvrirTransaction(t: Transaction): string | undefined {
      purger();
      if (transactions.size >= plafond) return undefined;
      const etat = aleatoire();
      transactions.set(etat, { ...t, expireA: maintenant() + DUREE_TRANSACTION });
      return etat;
    },
    // La transaction est détruite dès la première lecture, même si la suite échoue.
    consommerTransaction(etat: string): Transaction | undefined {
      const t = transactions.get(etat);
      transactions.delete(etat);
      if (!t || t.expireA <= maintenant()) return undefined;
      return { verifier: t.verifier, nonce: t.nonce, retour: t.retour };
    },
    // Nouvel identifiant aléatoire à chaque connexion : jamais celui qui vient du navigateur.
    ouvrirSession(s: Identite & Jetons): Session {
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
    // Jeton d'accès valable de la session. Une seule promesse en vol par session (attente partagée) : si Keycloak fait tourner les jetons
    // de rafraîchissement, une seconde demande simultanée échouerait et fermerait la session. Refus du renouvellement : session fermée.
    async jetonAcces(id: string, renouveler: (jetonRafraichissement: string) => Promise<Renouvele>): Promise<string | undefined> {
      const s = this.lireSession(id);
      if (!s) return undefined;
      if (s.accesExpireA - MARGE_ACCES > maintenant()) return s.jetonAcces;
      let promesse = enVol.get(id);
      if (!promesse) {
        promesse = renouveler(s.jetonRafraichissement)
          .then((r) => {
            s.jetonAcces = r.jetonAcces;
            s.jetonRafraichissement = r.jetonRafraichissement;
            s.accesExpireA = maintenant() + r.expireDans * 1000;
            return r.jetonAcces;
          })
          .catch(() => {
            sessions.delete(id);
            return undefined;
          })
          .finally(() => { enVol.delete(id); });
        enVol.set(id, promesse);
      }
      return promesse;
    },
  };
  return magasin;
}
// Ancré sur globalThis : connexion, rappel et déconnexion sont des entrées distinctes du bundle Next.js, le module peut être chargé plusieurs fois.
const CLE_MAGASIN = Symbol.for("axion.portail.magasin");
const global = globalThis as unknown as Record<symbol, ReturnType<typeof creerMagasin> | undefined>;
export const magasin = (global[CLE_MAGASIN] ??= creerMagasin());

const BASE = "Path=/; Secure; HttpOnly; SameSite=Lax";
// Lax (choix de la fiche) : Keycloak ramène le navigateur depuis un autre site ; le rappel répond en 302 direct, sans page de relais.
export const cookieSession = (id: string, secondes: number) => `${COOKIE_SESSION}=${id}; ${BASE}; Max-Age=${secondes}`;
export const cookieTransaction = (etat: string) => `${COOKIE_TRANSACTION}=${etat}; ${BASE}; Max-Age=600`;
export const cookieEffacer = (nom: string) => `${nom}=; ${BASE}; Max-Age=0`;

export function lireCookie(entete: string | null, nom: string): string | undefined {
  return entete?.split(/;\s*/).map((c) => c.split(/=(.*)/s)).find(([k]) => k === nom)?.[1] || undefined;
}

// Chaque gestionnaire de route revérifie la session lui-même : le middleware ne voit que l'existence du cookie.
export function sessionDe(requete: Request): Session | undefined {
  const id = lireCookie(requete.headers.get("cookie"), COOKIE_SESSION);
  return id ? magasin.lireSession(id) : undefined;
}
