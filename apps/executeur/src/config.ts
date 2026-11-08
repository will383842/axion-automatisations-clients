import { clesAcceptees, EPINGLEES, type ClePublique, type Environnement, type ListesEpinglees } from "../../../packages/sdk-module/src/emballage/cles-publiques.ts";

export type Palier = "essentiel" | "pro" | "etendu";

export interface ConfigExecuteur {
  cellule: string;
  valkey: { host: string; port: number };
  // Places simultanées par client selon son palier : lues ici, jamais en dur dans le travailleur.
  placesParPalier: Record<Palier, number>;
  bailPlaceMs: number;
  // Équité entre clients (T4-53), tout à 0 = fermé : plafond de places par module, fenêtre d'étalement des heures fixes (minutes), tour de rôle.
  placesParModule: number;
  etalementMin: number;
  tourDeRole: boolean;
  delaiRemiseMs: number;
  // Travaux traités en même temps par la cellule : plus grand que le plus grand palier, pour servir plusieurs clients.
  concurrence: number;
  // « production » par défaut. Les clés acceptées en découlent : la liste épinglée du dépôt, jamais une valeur lue d'une requête ou d'une variable (T4-26).
  environnement: Environnement;
  clesAcceptees: readonly ClePublique[];
  // Limites d'envoi des fournisseurs (T4-45, A-275) relevées par T4-00 ; absente = aucune limite connue, jamais une valeur devinée. La marge de 20 % est appliquée par les plafonds.
  limitesFournisseur: Partial<Record<"microsoft365" | "gmail" | "imap", { parJour?: number; parMinute?: number }>>;
}

// Entier strictement positif ou refus au démarrage : une valeur non numérique ne passe jamais en silence.
function entier(env: Record<string, string | undefined>, cle: string, defaut: number): number {
  const brut = env[cle];
  if (brut === undefined) return defaut;
  const n = Number(brut);
  if (brut.trim() === "" || !Number.isInteger(n) || n <= 0) throw new Error(`${cle} doit être un entier strictement positif (reçu « ${brut} »)`);
  return n;
}

// Entier positif ou nul (0 = fonction fermée).
function entierOuZero(env: Record<string, string | undefined>, cle: string): number {
  const brut = env[cle];
  if (brut === undefined) return 0;
  const n = Number(brut);
  if (brut.trim() === "" || !Number.isInteger(n) || n < 0) throw new Error(`${cle} doit être un entier positif ou nul (reçu « ${brut} »)`);
  return n;
}

// Entier strictement positif ou absent (aucune valeur par défaut).
function entierOuAbsent(env: Record<string, string | undefined>, cle: string): number | undefined {
  return env[cle] === undefined ? undefined : entier(env, cle, 1);
}

function limitesFournisseur(env: Record<string, string | undefined>): ConfigExecuteur["limitesFournisseur"] {
  const sortie: ConfigExecuteur["limitesFournisseur"] = {};
  for (const f of ["microsoft365", "gmail", "imap"] as const) {
    const jour = entierOuAbsent(env, `EXECUTEUR_LIMITE_${f.toUpperCase()}_JOUR`);
    const minute = entierOuAbsent(env, `EXECUTEUR_LIMITE_${f.toUpperCase()}_MINUTE`);
    if (jour !== undefined || minute !== undefined) sortie[f] = { ...(jour === undefined ? {} : { parJour: jour }), ...(minute === undefined ? {} : { parMinute: minute }) };
  }
  return sortie;
}

export function chargerConfig(env: Record<string, string | undefined>, listes: ListesEpinglees = EPINGLEES): ConfigExecuteur {
  const hote = env.VALKEY_HOTE;
  if (!hote) throw new Error("VALKEY_HOTE est obligatoire");
  const brut = env.EXECUTEUR_ENVIRONNEMENT ?? "production";
  if (brut !== "production" && brut !== "recette") throw new Error("EXECUTEUR_ENVIRONNEMENT doit valoir production ou recette");
  // Échec fermé : l'image de production fixe NODE_ENV=production ; elle ne peut jamais prendre la liste de la recette, quelle que soit la variable posée.
  if (brut === "recette" && env.NODE_ENV === "production") throw new Error("EXECUTEUR_ENVIRONNEMENT=recette refusé sur un exécuteur de production (NODE_ENV=production)");
  return {
    cellule: env.EXECUTEUR_CELLULE ?? "auto-run-1",
    valkey: { host: hote, port: entier(env, "VALKEY_PORT", 6379) },
    placesParPalier: { essentiel: 2, pro: 4, etendu: 8 },
    placesParModule: entierOuZero(env, "EXECUTEUR_PLACES_PAR_MODULE"),
    etalementMin: entierOuZero(env, "EXECUTEUR_ETALEMENT_MIN"),
    tourDeRole: env.EXECUTEUR_TOUR_DE_ROLE === "1",
    bailPlaceMs: entier(env, "EXECUTEUR_BAIL_PLACE_MS", 300_000),
    delaiRemiseMs: entier(env, "EXECUTEUR_DELAI_REMISE_MS", 5_000),
    concurrence: entier(env, "EXECUTEUR_CONCURRENCE", 16),
    environnement: brut,
    clesAcceptees: clesAcceptees(brut, listes),
    limitesFournisseur: limitesFournisseur(env),
  };
}
