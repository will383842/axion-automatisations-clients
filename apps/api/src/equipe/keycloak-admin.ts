import type { LecteurSecrets } from "../secrets.ts";

// Adaptateur de l'API d'administration de Keycloak pour le compte de service « console-sessions » (T3-07a, ADR 0129).
// Méthodes FERMÉES : lire sessions et facteurs, fermer UNE session, chercher, créer (désactivé), activer, désactiver.
// Aucune méthode ne supprime un utilisateur, ne fixe un mot de passe, n'attribue un rôle ni n'usurpe. Royaume « equipe » fixé ici,
// jamais tiré d'une entrée. Le secret du compte n'est lu que par ce fichier ; ni le jeton ni une réponse de Keycloak ne sortent
// dans une erreur ou un journal : projection sur des champs fermés et codes fermés.

const ROYAUME = "equipe";
const CLIENT = "console-sessions";
const NOM_SECRET = "KC_SECRET_CONSOLE_SESSIONS";
const MARGE_JETON_MS = 30_000;
const DELAI_MS = 5_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTIONS_INVITE = ["UPDATE_PASSWORD", "CONFIGURE_TOTP"] as const;

export type CodeErreurKeycloak = "entree_invalide" | "indisponible" | "introuvable" | "conflit" | "reponse_invalide";
export type FacteurKeycloak = "otp" | "webauthn";
export interface SessionKeycloak { id: string; ouverteLe: number; derniereActivite: number }

// Message fixe : jamais le corps ni l'adresse de la réponse. Le statut HTTP est le seul détail gardé.
export class ErreurKeycloak extends Error {
  constructor(readonly code: CodeErreurKeycloak, readonly statut?: number) {
    super(`keycloak-admin : ${code}`);
    this.name = "ErreurKeycloak";
  }
}

export interface OptionsKeycloakAdmin {
  base: string;
  secrets: LecteurSecrets;
  fetch?: typeof fetch;
  maintenant?: () => number;
  journaliser?: (ligne: string) => void;
}

export function creerKeycloakAdmin(options: OptionsKeycloakAdmin) {
  const racine = new URL(options.base);
  if (!/^https?:$/.test(racine.protocol) || racine.pathname !== "/" || racine.search || racine.username) throw new Error("keycloak-admin : adresse de base invalide");
  const base = racine.origin;
  const http = options.fetch ?? fetch;
  const maintenant = options.maintenant ?? Date.now;
  const journaliser = options.journaliser ?? (() => undefined);
  let jeton: Promise<{ valeur: string; expire: number }> | undefined;

  const uuid = (v: unknown): string => {
    if (typeof v !== "string" || !UUID.test(v)) throw new ErreurKeycloak("entree_invalide");
    return encodeURIComponent(v);
  };
  const adresseElectronique = (v: unknown): string => {
    const e = typeof v === "string" ? v.trim().toLowerCase() : "";
    if (e.length > 254 || !/^[^\s@<>"',;()\\]+@[^\s@<>"',;()\\]+\.[^\s@<>"',;()\\]+$/.test(e)) throw new ErreurKeycloak("entree_invalide");
    return e;
  };
  const echoue = (geste: string, code: CodeErreurKeycloak, statut?: number): never => {
    journaliser(`keycloak-admin ${geste} ${code}${statut === undefined ? "" : ` statut=${statut}`}`);
    throw new ErreurKeycloak(code, statut);
  };
  const appeler = async (geste: string, url: string, init: RequestInit): Promise<Response> => {
    try {
      return await http(url, { ...init, redirect: "error", signal: AbortSignal.timeout(DELAI_MS) });
    } catch {
      return echoue(geste, "indisponible");
    }
  };

  const obtenirJeton = async (geste: string) => {
    const secret = await options.secrets.lire(NOM_SECRET).catch(() => echoue(geste, "indisponible"));
    const r = await appeler(geste, `${base}/realms/${ROYAUME}/protocol/openid-connect/token`, {
      method: "POST",
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: CLIENT, client_secret: secret }),
    });
    if (!r.ok) return echoue(geste, "indisponible", r.status);
    const j = (await r.json().catch(() => null)) as { access_token?: unknown; expires_in?: unknown } | null;
    if (typeof j?.access_token !== "string" || typeof j.expires_in !== "number") return echoue(geste, "reponse_invalide");
    return { valeur: j.access_token, expire: maintenant() + j.expires_in * 1000 - MARGE_JETON_MS };
  };
  // Un seul jeton par processus ; deux demandes simultanées partagent la même promesse ; un échec n'est jamais gardé.
  const jetonValide = async (geste: string): Promise<string> => {
    if (jeton === undefined) {
      const demande = obtenirJeton(geste);
      jeton = demande;
      demande.catch(() => { if (jeton === demande) jeton = undefined; });
    }
    const courant = await jeton;
    if (courant.expire <= maintenant()) {
      jeton = undefined;
      return jetonValide(geste);
    }
    return courant.valeur;
  };

  const admin = async (geste: string, methode: string, chemin: string, corps?: unknown): Promise<Response> => {
    const entetes: Record<string, string> = { authorization: `Bearer ${await jetonValide(geste)}` };
    if (corps !== undefined) entetes["content-type"] = "application/json";
    const r = await appeler(geste, `${base}/admin/realms/${ROYAUME}${chemin}`, { method: methode, headers: entetes, ...(corps === undefined ? {} : { body: JSON.stringify(corps) }) });
    if (r.status === 401) jeton = undefined;
    if (r.status === 404) return echoue(geste, "introuvable", 404);
    if (r.status === 409) return echoue(geste, "conflit", 409);
    if (!r.ok) return echoue(geste, "indisponible", r.status);
    return r;
  };
  const liste = async (r: Response, geste: string): Promise<Record<string, unknown>[]> => {
    const j: unknown = await r.json().catch(() => null);
    if (!Array.isArray(j)) return echoue(geste, "reponse_invalide");
    return j.filter((x): x is Record<string, unknown> => typeof x === "object" && x !== null);
  };

  return {
    async sessionsDe(userId: string): Promise<SessionKeycloak[]> {
      const id = uuid(userId);
      const brutes = await liste(await admin("sessionsDe", "GET", `/users/${id}/sessions`), "sessionsDe");
      return brutes.flatMap((s) =>
        typeof s["id"] === "string" && UUID.test(s["id"]) && typeof s["start"] === "number" && typeof s["lastAccess"] === "number"
          ? [{ id: s["id"], ouverteLe: s["start"], derniereActivite: s["lastAccess"] }]
          : [],
      );
    },
    // Types seulement : secretData et credentialData ne sont jamais copiés.
    async facteursDe(userId: string): Promise<FacteurKeycloak[]> {
      const id = uuid(userId);
      const types = (await liste(await admin("facteursDe", "GET", `/users/${id}/credentials`), "facteursDe")).map((c) => c["type"]);
      return (["otp", "webauthn"] as const).filter((f) => types.some((t) => t === f || (f === "webauthn" && t === "webauthn-passwordless")));
    },
    async fermerSession(sessionId: string): Promise<void> {
      await admin("fermerSession", "DELETE", `/sessions/${uuid(sessionId)}`);
    },
    async chercherParEmail(email: string): Promise<{ id: string; actif: boolean } | null> {
      const e = adresseElectronique(email);
      const q = new URLSearchParams({ email: e, exact: "true", max: "2" });
      const trouves = await liste(await admin("chercherParEmail", "GET", `/users?${q}`), "chercherParEmail");
      const [u] = trouves.filter((x) => typeof x["email"] !== "string" || x["email"].toLowerCase() === e);
      if (u === undefined) return null;
      if (typeof u["id"] !== "string" || !UUID.test(u["id"])) return echoue("chercherParEmail", "reponse_invalide");
      return { id: u["id"], actif: u["enabled"] === true };
    },
    // Créé DÉSACTIVÉ, sans mot de passe : l'invité le choisit lui-même, le double facteur est imposé à la première connexion.
    async creerUtilisateur(entree: { email: string }): Promise<{ id: string }> {
      const e = adresseElectronique(entree.email);
      const r = await admin("creerUtilisateur", "POST", "/users", { username: e, email: e, enabled: false, requiredActions: [...ACTIONS_INVITE] });
      const id = (r.headers.get("location") ?? "").match(/\/admin\/realms\/equipe\/users\/([0-9a-f-]{36})$/i)?.[1];
      if (id === undefined || !UUID.test(id)) return echoue("creerUtilisateur", "reponse_invalide");
      return { id };
    },
    async activer(userId: string): Promise<void> {
      await admin("activer", "PUT", `/users/${uuid(userId)}`, { enabled: true });
    },
    // Envoi par Keycloak lui-même (A3, interrupteur fermé côté appelant) : l'API ne voit jamais de lien d'action.
    async envoyerActions(userId: string): Promise<void> {
      await admin("envoyerActions", "PUT", `/users/${uuid(userId)}/execute-actions-email`, [...ACTIONS_INVITE]);
    },
    // Jamais de suppression : le compte est coupé, puis toutes ses sessions sont fermées.
    async desactiver(userId: string): Promise<void> {
      const id = uuid(userId);
      await admin("desactiver", "PUT", `/users/${id}`, { enabled: false });
      await admin("desactiver", "POST", `/users/${id}/logout`);
    },
  };
}

export type KeycloakAdmin = ReturnType<typeof creerKeycloakAdmin>;
