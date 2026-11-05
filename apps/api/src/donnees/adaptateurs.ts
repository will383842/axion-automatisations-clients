import pg from "pg";
import { z } from "zod";
import type { Masqueur } from "../plugins/journal.js";
import { LONGUEUR_MINIMALE } from "../plugins/journal.js";
import type { Connexion, RoleConnexion } from "./service.js";

// Adaptateurs de PortsDonnees (T2-37c) : registre des bases (lecture), mot de passe lu dans OpenBao (politique api), connexion par PgBouncer « données ».
// Règles communes : le nom de la base et du rôle viennent d'une forme fermée (cli_<12 hex>), les erreurs sont neutres (ni mot de passe, ni nom de base, ni corps de réponse),
// le mot de passe n'est jamais journalisé (il est inscrit au masqueur avant d'être rendu, A-005) et n'est jamais gardé après l'ouverture.
const BASE = /^cli_[0-9a-f]{12}$/;
const ROLES: readonly RoleConnexion[] = ["app", "lecture"];
const neutre = () => new Error("Service indisponible.");

export interface SqlRegistre { requete(texte: string, valeurs: unknown[]): Promise<Record<string, unknown>[]> }

// `avecClient` = la connexion de la console déjà limitée à CE client (RLS) ; le registre ne lit que la ligne de ce client.
export function creerRegistreBases(avecClient: <T>(tenantId: string, fn: (sql: SqlRegistre) => Promise<T>) => Promise<T>) {
  return async (tenantId: string): Promise<{ nomBase: string; etat: string } | undefined> => {
    if (!z.uuid().safeParse(tenantId).success) return undefined;
    const ligne = (await avecClient(tenantId, (sql) => sql.requete("SELECT nom_base, etat FROM bases_client WHERE tenant_id = $1 LIMIT 1", [tenantId])))[0];
    const nomBase = ligne?.["nom_base"];
    const etat = ligne?.["etat"];
    // Un nom hors forme vaut pas de base : il n'atteint jamais le chemin du coffre ni le nom d'une connexion.
    return typeof nomBase === "string" && BASE.test(nomBase) && typeof etat === "string" ? { nomBase, etat } : undefined;
  };
}

export interface LecteurMotDePasse { lire(nomBase: string, role: RoleConnexion): Promise<string> }
export function creerLecteurMotDePasse(o: { url: string; jeton: string; fetch?: typeof fetch; masqueur?: Masqueur }): LecteurMotDePasse {
  return {
    async lire(nomBase, role) {
      if (typeof nomBase !== "string" || !BASE.test(nomBase) || !ROLES.includes(role)) throw neutre();
      const reponse = await (o.fetch ?? fetch)(`${o.url}/v1/technique/data/donnees/${nomBase}/${role}`, {
        headers: { "X-Vault-Token": o.jeton },
        redirect: "error", // le jeton ne suit jamais une redirection
        signal: AbortSignal.timeout(5000),
      }).catch(() => undefined);
      // Le corps d'une réponse en erreur n'est jamais repris.
      if (!reponse?.ok) throw neutre();
      const corps = (await reponse.json().catch(() => undefined)) as { data?: { data?: { valeur?: unknown } } } | undefined;
      const valeur = corps?.data?.data?.valeur;
      if (typeof valeur !== "string" || valeur.length < LONGUEUR_MINIMALE) throw neutre();
      o.masqueur?.ajouter(valeur);
      return valeur;
    },
  };
}

export interface ClientPg {
  connect(): Promise<unknown>;
  query(texte: string, valeurs: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<unknown>;
}
type FabriquePg = (config: { host: string; port: number; database: string; user: string; password: string; connectionTimeoutMillis: number; statement_timeout: number }) => ClientPg;
const fabriquePg: FabriquePg = (config) => {
  const client = new pg.Client(config);
  client.on("error", () => undefined);
  return client as unknown as ClientPg;
};

// Une connexion par (base, rôle) par PgBouncer « données » (jamais la grappe en direct, jamais un rôle propriétaire ni le provisionneur).
export function creerOuvreurConnexions(o: { hote: string; port: number; lecteur: LecteurMotDePasse; fabrique?: FabriquePg }) {
  return async (nomBase: string, role: RoleConnexion): Promise<Connexion> => {
    if (typeof nomBase !== "string" || !BASE.test(nomBase) || !ROLES.includes(role)) throw neutre();
    const motDePasse = await o.lecteur.lire(nomBase, role);
    const client = (o.fabrique ?? fabriquePg)({ host: o.hote, port: o.port, database: nomBase, user: `${nomBase}_${role}`, password: motDePasse, connectionTimeoutMillis: 2000, statement_timeout: 5000 });
    try {
      await client.connect();
    } catch {
      // Le message d'origine peut citer le mot de passe ou la base : il est jeté.
      await client.end().catch(() => undefined);
      throw neutre();
    }
    return {
      async requete(texte, valeurs) { return (await client.query(texte, valeurs)).rows; },
      async fermer() { await client.end().catch(() => undefined); },
    };
  };
}
