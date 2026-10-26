import { randomUUID } from "node:crypto";
import { LONGUEUR_MINIMALE, type Masqueur } from "../plugins/journal.js";

// Coffre des identifiants des clients (C-011) : OpenBao, KV v2 monté sur clients/.
// La base ne garde que la référence « bao:clients/<tenantId>/<uuid> ». La valeur ne passe que dans le corps d'une requête :
// jamais dans une adresse, un message d'erreur ou un journal. Chaque rôle a son jeton ; les droits sont dans ops/socle/openbao/politiques.

export type CodeCoffre =
  | "coffre_scelle"
  | "coffre_indisponible"
  | "refuse"
  | "introuvable"
  | "requete_refusee"
  | "tenant_invalide"
  | "reference_invalide"
  | "reference_etrangere"
  | "confirmation_absente"
  | "dechiffrement_impossible";

// Le message est le code seul : aucune réponse du coffre, aucun jeton, aucune valeur n'y entre.
export class ErreurCoffre extends Error {
  constructor(readonly code: CodeCoffre) {
    super(code);
    this.name = "ErreurCoffre";
  }
}

export interface OptionsBao {
  url: string;
  jeton: string;
  fetch?: typeof fetch;
  // Toute valeur rangée ou relue y est inscrite : le journal la masque ensuite sous toutes ses formes.
  masqueur?: Masqueur;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DELAI_MS = 5000;
// Seuls les montages clients/ et transit/, en segments simples : ni « .. », ni « ? », ni « % », ni barre double.
const CHEMIN = /^(?:clients|transit)(?:\/[a-z0-9-]+)+$/;

export function validerTenant(tenantId: string): string {
  if (typeof tenantId !== "string" || !UUID.test(tenantId)) throw new ErreurCoffre("tenant_invalide");
  return tenantId;
}

export async function appeler(o: OptionsBao, methode: "GET" | "POST" | "DELETE", chemin: string, corps?: unknown): Promise<unknown> {
  if (!CHEMIN.test(chemin)) throw new ErreurCoffre("requete_refusee");
  let reponse: Response;
  try {
    reponse = await (o.fetch ?? fetch)(`${o.url}/v1/${chemin}`, {
      method: methode,
      headers: { "X-Vault-Token": o.jeton, ...(corps === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(corps === undefined ? {} : { body: JSON.stringify(corps) }),
      redirect: "error", // X-Vault-Token et le corps ne suivent jamais une redirection
      signal: AbortSignal.timeout(DELAI_MS),
    });
  } catch {
    throw new ErreurCoffre("coffre_indisponible");
  }
  if (reponse.status === 503) {
    const texte = await reponse.text().catch(() => "");
    throw new ErreurCoffre(texte.toLowerCase().includes("sealed") ? "coffre_scelle" : "coffre_indisponible");
  }
  if (reponse.status === 403) throw new ErreurCoffre("refuse");
  if (reponse.status === 404) throw new ErreurCoffre("introuvable");
  if (reponse.status >= 500) throw new ErreurCoffre("coffre_indisponible");
  if (reponse.status >= 300) throw new ErreurCoffre("requete_refusee");
  const texte = await reponse.text().catch(() => "");
  if (!texte) return undefined;
  try {
    return JSON.parse(texte) as unknown;
  } catch {
    throw new ErreurCoffre("coffre_indisponible");
  }
}

const objet = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

// Une référence du client demandé, et d'aucun autre : tout ce qui n'est pas exactement bao:clients/<uuid>/<uuid> est refusé avant l'appel.
function cheminDe(tenantId: string, reference: string): string {
  validerTenant(tenantId);
  const prefixe = "bao:clients/";
  if (typeof reference !== "string" || !reference.startsWith(prefixe)) throw new ErreurCoffre("reference_invalide");
  const morceaux = reference.slice(prefixe.length).split("/");
  const [t, u] = morceaux;
  if (morceaux.length !== 2 || !UUID.test(t ?? "") || !UUID.test(u ?? "")) throw new ErreurCoffre("reference_invalide");
  if (t !== tenantId) throw new ErreurCoffre("reference_etrangere");
  return `${t}/${u}`;
}

export interface EtatIdentifiant {
  nom: string;
  etat: "present" | "absent";
  expireLe: string | null;
}

export interface Coffre {
  rangerIdentifiant(tenantId: string, nom: string, valeur: string, options?: { expireLe?: string }): Promise<string>;
  lireEtat(tenantId: string, reference: string): Promise<EtatIdentifiant>;
  lireValeur(tenantId: string, reference: string): Promise<string>;
}

export function creerCoffre(o: OptionsBao): Coffre {
  return {
    async rangerIdentifiant(tenantId, nom, valeur, options = {}) {
      validerTenant(tenantId);
      const { expireLe = "" } = options;
      // Une valeur trop courte pour le masqueur est refusée, jamais rangée sans protection (A-005, ADR 0023).
      if (!nom || typeof valeur !== "string" || valeur.length < LONGUEUR_MINIMALE || (expireLe && Number.isNaN(Date.parse(expireLe)))) throw new ErreurCoffre("requete_refusee");
      o.masqueur?.ajouter(valeur);
      const p = `${tenantId}/${randomUUID()}`;
      // KV v2 refuse une valeur vide dans custom_metadata : expire_le n'est envoyé que s'il existe.
      // Métadonnées d'abord : un échec ne laisse jamais une valeur sans référence.
      await appeler(o, "POST", `clients/metadata/${p}`, { custom_metadata: { nom, ...(expireLe ? { expire_le: expireLe } : {}) } });
      await appeler(o, "POST", `clients/data/${p}`, { data: { nom, valeur } });
      return `bao:clients/${p}`;
    },
    async lireEtat(tenantId, reference) {
      const m = objet(objet(await appeler(o, "GET", `clients/metadata/${cheminDe(tenantId, reference)}`)).data);
      const c = objet(m.custom_metadata);
      if (typeof c.nom !== "string") throw new ErreurCoffre("coffre_indisponible");
      return { nom: c.nom, etat: Number(m.current_version) >= 1 ? "present" : "absent", expireLe: typeof c.expire_le === "string" && c.expire_le ? c.expire_le : null };
    },
    async lireValeur(tenantId, reference) {
      const valeur = objet(objet(objet(await appeler(o, "GET", `clients/data/${cheminDe(tenantId, reference)}`)).data).data).valeur;
      if (typeof valeur !== "string" || valeur.length < LONGUEUR_MINIMALE) throw new ErreurCoffre("coffre_indisponible");
      o.masqueur?.ajouter(valeur);
      return valeur;
    },
  };
}
