// Limites du port données, lues de la configuration au démarrage (jamais d'une requête ni du module). Échec fermé : valeur illisible ou liste d'hôtes absente = refus.
// `hotes` : liste fermée des hôtes de la grappe de bases (PgBouncer « données ») que le courtier peut remettre.
// `delaiTotalMs` borne une lecture entière, attente en file, remise du courtier et ouverture comprises.
export interface LimitesDonnees { delaiMs: number; delaiTotalMs: number; maxLignes: number; hotes: readonly string[] }

// Lectures en cours ou en attente au plus, par client et par processus : au-delà, « indisponible » tout de suite.
export const PROFONDEUR_FILE = 8;

const HOTE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

function entier(env: Record<string, string | undefined>, cle: string, defaut: number, max: number): number {
  const brut = env[cle];
  if (brut === undefined) return defaut;
  const n = Number(brut);
  if (!/^[0-9]+$/.test(brut) || n < 1 || n > max) throw new Error(`${cle} doit être un entier entre 1 et ${max}`);
  return n;
}

export function lireLimitesDonnees(env: Record<string, string | undefined>): LimitesDonnees {
  const brut = env["EXECUTEUR_DONNEES_HOTES"];
  const hotes = (brut ?? "").split(",").map((h) => h.trim());
  if (!brut || hotes.some((h) => h.length > 253 || !HOTE.test(h))) throw new Error("EXECUTEUR_DONNEES_HOTES est obligatoire : noms d'hôtes séparés par des virgules");
  const delaiMs = entier(env, "EXECUTEUR_DONNEES_DELAI_MS", 5000, 60_000);
  const delaiTotalMs = entier(env, "EXECUTEUR_DONNEES_DELAI_TOTAL_MS", 15_000, 300_000);
  // La sonde et la requête ont chacune leur délai : un total plus court abandonnerait toute lecture lente alors que la requête continue.
  if (delaiTotalMs < 2 * delaiMs + 1000) throw new Error("EXECUTEUR_DONNEES_DELAI_TOTAL_MS doit valoir au moins 2 × EXECUTEUR_DONNEES_DELAI_MS + 1000");
  return { delaiMs, delaiTotalMs, maxLignes: entier(env, "EXECUTEUR_DONNEES_MAX_LIGNES", 200, 200), hotes };
}
