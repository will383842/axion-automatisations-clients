import { Redis } from "ioredis";

// Connexion unique à Valkey (A-051). Refuse de démarrer si le serveur n'est pas Valkey ou si une éviction est possible :
// avec une autre politique que noeviction, Valkey peut effacer des tâches de la file.

export function analyserInfo(info: string): Map<string, string> {
  const lignes = new Map<string, string>();
  for (const ligne of info.split(/\r?\n/)) {
    if (ligne === "" || ligne.startsWith("#")) continue;
    const i = ligne.indexOf(":");
    if (i > 0) lignes.set(ligne.slice(0, i), ligne.slice(i + 1));
  }
  return lignes;
}

export function verifierServeur(infoServer: string, politique: string): string[] {
  const erreurs: string[] = [];
  if (analyserInfo(infoServer).get("server_name") !== "valkey") erreurs.push("le serveur n'est pas Valkey");
  if (politique !== "noeviction") erreurs.push(`maxmemory-policy vaut « ${politique} » au lieu de « noeviction »`);
  return erreurs;
}

export interface Connexion {
  client: Redis;
  info: (section: string) => Promise<string>;
  quit: () => Promise<void>;
}

export interface Parametres {
  host: string;
  port: number;
  password: string;
}

export async function ouvrirConnexion(options: Parametres): Promise<Connexion> {
  // BullMQ exige maxRetriesPerRequest: null pour ses clients bloquants.
  const client = new Redis({ host: options.host, port: options.port, password: options.password, maxRetriesPerRequest: null });
  try {
    const infoServer = String(await client.info("server"));
    const reponse = (await client.config("GET", "maxmemory-policy")) as string[];
    const erreurs = verifierServeur(infoServer, reponse[1] ?? "");
    if (erreurs.length > 0) throw new Error(`Valkey refusé : ${erreurs.join(" ; ")}`);
  } catch (e) {
    client.disconnect();
    throw e;
  }
  return {
    client,
    info: async (section) => String(await client.info(section)),
    quit: async () => {
      await client.quit();
    },
  };
}
