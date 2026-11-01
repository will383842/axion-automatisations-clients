import { CONSERVATION_JTI_SECONDES } from "../../../../packages/contrats/src/c6/jeton.js";
import { LIMITES_DEBIT } from "../../../../packages/contrats/src/commun/debit.js";
import { verifierJeton } from "../../../../packages/contrats/src/c6/verifier.js";
import type { Alertes } from "../alertes/port.js";
import type { CleEchange, Sens } from "../coffre/cles-echanges.js";

// Réception du lien signé C6 (C-404). Le jeton n'est JAMAIS un facteur d'authentification : il ne donne aucune session,
// il ne sert qu'à nommer l'e-mail (login_hint) de la connexion Keycloak, qui redemande le double facteur (prompt=login, acr_values=mfa).
// La vérification est celle de packages/contrats (jamais recopiée). Toute erreur renvoie la même réponse : la page de connexion normale.

export interface Memoire {
  set(cle: string, valeur: string, ex: "EX", secondes: number, nx: "NX"): Promise<"OK" | null>;
  incr(cle: string): Promise<number>;
}
export interface DepsEntree {
  cles: { clesAcceptees(canal: string, sens: Sens): Promise<CleEchange[]> };
  memoire: Memoire;
  alertes: Alertes;
  // Adresse d'autorisation du royaume de l'équipe (T1A-08) et client OIDC « console » : valeurs fournies par l'appelant.
  keycloak: { autorisation: string; clientId: string; redirectUri: string };
  connexionNormale: string;
  maintenant?: () => number;
  // Plancher de durée de chaque réponse : le temps ne dit pas pourquoi un lien est refusé.
  plancherMs?: number;
  attendre?: (ms: number) => Promise<void>;
}
export type Resultat = { statut: 200; url: string } | { statut: 429; retryAfter: number };
// Le détail d'un refus : un code seulement, jamais le jeton, l'e-mail ni l'adresse.
export type Noter = (code: "limite" | "jeton_invalide" | "rejeu" | "memoire_indisponible" | "cles_indisponibles" | "requete_refusee" | "forme") => void;

// Limites lues dans le contrat gelé (CLAUDE.md §5), jamais recopiées.
export const ESSAIS_PAR_MINUTE = LIMITES_DEBIT.c6.parMinute;
export const REFUS_AVANT_ALERTE = LIMITES_DEBIT.c6.alerteRefusParMinute;
const DELAI_MS = 2000;
const PLANCHER_MS = 150;

const delai = <T>(p: Promise<T>): Promise<T> => {
  let minuteur: NodeJS.Timeout | undefined;
  const limite = new Promise<never>((_, non) => (minuteur = setTimeout(() => non(new Error("delai")), DELAI_MS)));
  return Promise.race([p, limite]).finally(() => clearTimeout(minuteur));
};

// Compteur de minute : la clé naît avec sa durée de vie (SET NX EX, atomique), puis INCR. Jamais de clé sans expiration.
async function compter(memoire: Memoire, cle: string): Promise<number> {
  await delai(memoire.set(cle, "0", "EX", 120, "NX"));
  return delai(memoire.incr(cle));
}

export function creerEntree(deps: DepsEntree) {
  const maintenant = deps.maintenant ?? (() => Math.floor(Date.now() / 1000));
  const attendre = deps.attendre ?? ((ms: number) => new Promise<void>((ok) => setTimeout(ok, ms)));
  const refuse = { statut: 200, url: deps.connexionNormale } as const;

  // Compte les refus de la minute ; une seule alerte, au dixième. Au mieux : une panne ici ne change pas la réponse.
  async function compterRefus(minute: number): Promise<void> {
    try {
      const cle = `entree-refus:${minute}`;
      const n = await compter(deps.memoire, cle);
      if (n === REFUS_AVANT_ALERTE) await deps.alertes.envoyer({ type: "soupcon_acces_non_autorise", clientId: "console-equipe" });
    } catch {
      // volontairement muet
    }
  }

  // E-mail : transmis tel quel (forme validée par le contrat), sans passage en minuscules ici. Aucune comparaison n'est faite dans cette route ;
  // c'est Keycloak qui rapproche le login_hint du compte, sans tenir compte de la casse.
  function adresseKeycloak(email: string): string {
    const u = new URL(deps.keycloak.autorisation);
    u.search = "";
    // URLSearchParams encode chaque valeur : l'e-mail (forme déjà validée par le contrat) ne peut ajouter aucun paramètre.
    for (const [nom, valeur] of [["client_id", deps.keycloak.clientId], ["redirect_uri", deps.keycloak.redirectUri], ["response_type", "code"], ["scope", "openid"], ["login_hint", email], ["prompt", "login"], ["acr_values", "mfa"]] as const) u.searchParams.set(nom, valeur);
    return u.toString();
  }

  async function traiter(corps: unknown, adresse: string, avecRequete: boolean, noter: Noter): Promise<Resultat> {
    const minute = Math.floor(maintenant() / 60);
    const echec = async (code: Parameters<Noter>[0]): Promise<Resultat> => {
      noter(code);
      await compterRefus(minute);
      return refuse;
    };
    // Limite par adresse : une panne de Valkey refuse (jamais d'accès sans limite).
    try {
      const cle = `entree-limite:${adresse}:${minute}`;
      const n = await compter(deps.memoire, cle);
      if (n > ESSAIS_PAR_MINUTE) {
        noter("limite");
        await compterRefus(minute);
        // Il reste au plus 60 s avant la minute suivante (Retry-After : entier de 1 à 60).
        return { statut: 429, retryAfter: Math.min(60, Math.max(1, 60 - (maintenant() % 60))) };
      }
    } catch {
      return echec("memoire_indisponible");
    }
    // Le jeton ne vient que du corps : un jeton passé dans l'adresse est refusé.
    if (avecRequete) return echec("requete_refusee");
    let jeton: unknown;
    try {
      jeton = (typeof corps === "string" ? (JSON.parse(corps) as { jeton?: unknown } | null) : null)?.jeton;
    } catch {
      jeton = undefined;
    }
    if (typeof jeton !== "string" || jeton === "") return echec("forme");
    let acceptees: CleEchange[];
    try {
      acceptees = await delai(deps.cles.clesAcceptees("c6", "reception"));
    } catch {
      return echec("cles_indisponibles");
    }
    // Le rappel du contrat est synchrone : il ne fait que retenir le jti ; la consommation (SET NX) vient ensuite, après toutes les vérifications.
    let jti: string | undefined;
    const lu = verifierJeton(acceptees.map((k) => ({ kid: k.kid, secret: k.secret.toString("base64") })), jeton, maintenant(), (j) => ((jti = j), false));
    if (!lu.ok || jti === undefined) return echec("jeton_invalide");
    try {
      const neuf = await delai(deps.memoire.set(`entree-jti:${jti}`, "1", "EX", CONSERVATION_JTI_SECONDES, "NX"));
      if (neuf !== "OK") return echec("rejeu");
    } catch {
      return echec("memoire_indisponible");
    }
    return { statut: 200, url: adresseKeycloak(lu.email) };
  }

  return async (corps: unknown, adresse: string, avecRequete: boolean, noter: Noter): Promise<Resultat> => {
    const [resultat] = await Promise.all([traiter(corps, adresse, avecRequete, noter).catch((): Resultat => refuse), attendre(deps.plancherMs ?? PLANCHER_MS)]);
    return resultat;
  };
}
