export type Palier = "essentiel" | "pro" | "etendu";

export interface ConfigExecuteur {
  cellule: string;
  valkey: { host: string; port: number };
  // Places simultanées par client selon son palier : lues ici, jamais en dur dans le travailleur.
  placesParPalier: Record<Palier, number>;
  bailPlaceMs: number;
  delaiRemiseMs: number;
}

export function chargerConfig(env: Record<string, string | undefined>): ConfigExecuteur {
  return {
    cellule: env.EXECUTEUR_CELLULE ?? "auto-run-1",
    valkey: { host: env.VALKEY_HOTE ?? "127.0.0.1", port: Number(env.VALKEY_PORT ?? 6379) },
    placesParPalier: { essentiel: 2, pro: 4, etendu: 8 },
    bailPlaceMs: Number(env.EXECUTEUR_BAIL_PLACE_MS ?? 300_000),
    delaiRemiseMs: Number(env.EXECUTEUR_DELAI_REMISE_MS ?? 5_000),
  };
}
