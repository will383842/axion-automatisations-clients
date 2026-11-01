// Configuration de la console, lue dans l'environnement à chaque appel (jamais écrite en dur).
type Env = Record<string, string | undefined>;

export interface Configuration {
  emetteur: string; // royaume « equipe » de Keycloak
  clientId: string;
  secret: string;
  origine: string; // origine publique de la console (HTTPS)
}

// Interrupteur fermé par défaut : la route de connexion ne répond que si la variable vaut exactement « 1 ».
export const connexionOuverte = (env: Env = process.env): boolean => env["CONSOLE_CONNEXION_OUVERTE"] === "1";

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
    emetteur: https(env["CONSOLE_EMETTEUR_OIDC"], "CONSOLE_EMETTEUR_OIDC"),
    clientId: requis(env["CONSOLE_CLIENT_OIDC"], "CONSOLE_CLIENT_OIDC"),
    secret: requis(env["CONSOLE_SECRET_OIDC"], "CONSOLE_SECRET_OIDC"),
    origine: https(env["CONSOLE_ORIGINE"], "CONSOLE_ORIGINE"),
  };
}

// A-104 : lien vers le back-office d'axion-ia ; absent ou invalide → pas de lien.
export function adresseBackOffice(env: Env = process.env): string | null {
  try {
    return https(env["BACKOFFICE_URL"], "BACKOFFICE_URL");
  } catch {
    return null;
  }
}
