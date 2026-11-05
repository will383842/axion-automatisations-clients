import { randomUUID } from "node:crypto";

// Verrou par connexion (T4-40) : bail court, jeton de verrou vérifié à la prolongation et à la libération.
// Celui dont le bail a expiré ne peut ni prolonger ni libérer le verrou d'un autre.
export interface Verrou {
  prendre(cle: string, bailMs: number): Promise<string | null>; // jeton de verrou, ou null si déjà tenu
  prolonger(cle: string, jeton: string, bailMs: number): Promise<boolean>;
  liberer(cle: string, jeton: string): Promise<void>;
}

export function creerVerrouMemoire(maintenant: () => number): Verrou {
  const tenus = new Map<string, { jeton: string; fin: number }>();
  const tenu = (cle: string, jeton: string) => { const e = tenus.get(cle); return e && e.jeton === jeton && e.fin > maintenant() ? e : undefined; };
  return {
    prendre: async (cle, bailMs) => {
      const e = tenus.get(cle);
      if (e && e.fin > maintenant()) return null;
      const jeton = randomUUID();
      tenus.set(cle, { jeton, fin: maintenant() + bailMs });
      return jeton;
    },
    prolonger: async (cle, jeton, bailMs) => { const e = tenu(cle, jeton); if (e) e.fin = maintenant() + bailMs; return e !== undefined; },
    liberer: async (cle, jeton) => { if (tenus.get(cle)?.jeton === jeton) tenus.delete(cle); },
  };
}

// Marque durable « renouvellement en cours » (T4-40) : posée avant l'appel au fournisseur, sans durée ; seul un effacement explicite la retire.
// Tant qu'elle existe, aucun titulaire du verrou n'appelle le fournisseur : le jeton tournant a peut-être été consommé.
export interface MarqueRenouvellement {
  poser(cle: string): Promise<void>;
  presente(cle: string): Promise<boolean>;
  effacer(cle: string): Promise<void>;
}
export function creerMarqueMemoire(): MarqueRenouvellement {
  const posees = new Set<string>();
  return { poser: async (cle) => { posees.add(cle); }, presente: async (cle) => posees.has(cle), effacer: async (cle) => { posees.delete(cle); } };
}

// Sous-ensemble de ioredis (Valkey) : SET ... PX ... NX et EVAL. Aucune dépendance ajoutée ici.
export interface ClientValkey {
  set(cle: string, valeur: string, ...args: (string | number)[]): Promise<string | null>;
  eval(script: string, nombreCles: number, ...args: (string | number)[]): Promise<unknown>;
}
const PROLONGER = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end";
const LIBERER = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

export function creerVerrouValkey(client: ClientValkey, prefixe = "verrou:renouvellement:"): Verrou {
  return {
    prendre: async (cle, bailMs) => {
      const jeton = randomUUID();
      return (await client.set(prefixe + cle, jeton, "PX", bailMs, "NX")) === "OK" ? jeton : null;
    },
    prolonger: async (cle, jeton, bailMs) => Number(await client.eval(PROLONGER, 1, prefixe + cle, jeton, bailMs)) === 1,
    liberer: async (cle, jeton) => { await client.eval(LIBERER, 1, prefixe + cle, jeton); },
  };
}

const EXISTE = "return redis.call('exists', KEYS[1])";
const EFFACER = "return redis.call('del', KEYS[1])";
// Marque Valkey : SET sans durée (aucun PX) ; la persistance du Valkey du socle la garde après redémarrage.
export function creerMarqueValkey(client: ClientValkey, prefixe = "marque:renouvellement:"): MarqueRenouvellement {
  return {
    poser: async (cle) => { await client.set(prefixe + cle, "1"); },
    presente: async (cle) => Number(await client.eval(EXISTE, 1, prefixe + cle)) === 1,
    effacer: async (cle) => { await client.eval(EFFACER, 1, prefixe + cle); },
  };
}
