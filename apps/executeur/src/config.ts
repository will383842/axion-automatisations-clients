export type Palier = "essentiel" | "pro" | "etendu";

export interface ConfigExecuteur {
  cellule: string;
  valkey: { host: string; port: number };
  // Places simultanées par client selon son palier : lues ici, jamais en dur dans le travailleur.
  placesParPalier: Record<Palier, number>;
  bailPlaceMs: number;
  delaiRemiseMs: number;
  // Travaux traités en même temps par la cellule : plus grand que le plus grand palier, pour servir plusieurs clients.
  concurrence: number;
}

// Entier strictement positif ou refus au démarrage : une valeur non numérique ne passe jamais en silence.
function entier(env: Record<string, string | undefined>, cle: string, defaut: number): number {
  const brut = env[cle];
  if (brut === undefined) return defaut;
  const n = Number(brut);
  if (brut.trim() === "" || !Number.isInteger(n) || n <= 0) throw new Error(`${cle} doit être un entier strictement positif (reçu « ${brut} »)`);
  return n;
}

export function chargerConfig(env: Record<string, string | undefined>): ConfigExecuteur {
  const hote = env.VALKEY_HOTE;
  if (!hote) throw new Error("VALKEY_HOTE est obligatoire");
  return {
    cellule: env.EXECUTEUR_CELLULE ?? "auto-run-1",
    valkey: { host: hote, port: entier(env, "VALKEY_PORT", 6379) },
    placesParPalier: { essentiel: 2, pro: 4, etendu: 8 },
    bailPlaceMs: entier(env, "EXECUTEUR_BAIL_PLACE_MS", 300_000),
    delaiRemiseMs: entier(env, "EXECUTEUR_DELAI_REMISE_MS", 5_000),
    concurrence: entier(env, "EXECUTEUR_CONCURRENCE", 16),
  };
}
