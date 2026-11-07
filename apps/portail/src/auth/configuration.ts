// Configuration du portail, lue dans l'environnement à chaque appel (jamais écrite en dur).
type Env = Record<string, string | undefined>;

export interface Configuration {
  emetteur: string; // royaume « clients » de Keycloak
  clientId: string;
  secret: string;
  origine: string; // origine publique du portail (HTTPS)
}

// Interrupteur fermé par défaut : les routes de connexion ne répondent que si la variable vaut exactement « 1 ».
export const connexionOuverte = (env: Env = process.env): boolean => env["PORTAIL_CONNEXION_OUVERTE"] === "1";

// Les noms sont écrits en toutes lettres (env["…"]) pour que la garde de l'inventaire des secrets (A-115) les voie.
function https(valeur: string | undefined, nom: string): string {
  try {
    const u = new URL(valeur ?? "");
    if (u.protocol === "https:" && !u.search && !u.hash) return u.href.replace(/\/$/, "");
  } catch {
    // refus plus bas
  }
  throw new Error(`${nom} doit être une adresse HTTPS sans paramètre`);
}

export function lireConfiguration(env: Env = process.env): Configuration {
  const requis = (valeur: string | undefined, nom: string) => valeur || (() => { throw new Error(`${nom} est absente`); })();
  return {
    emetteur: https(env["PORTAIL_EMETTEUR_OIDC"], "PORTAIL_EMETTEUR_OIDC"),
    clientId: requis(env["PORTAIL_CLIENT_OIDC"], "PORTAIL_CLIENT_OIDC"),
    secret: requis(env["PORTAIL_SECRET_OIDC"], "PORTAIL_SECRET_OIDC"),
    origine: https(env["PORTAIL_ORIGINE"], "PORTAIL_ORIGINE"),
  };
}
