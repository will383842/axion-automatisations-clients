import { z } from "zod";
import { masquer } from "../../../../../packages/observabilite/src/nettoyage.ts";
import { ErreurApi } from "../../plugins/erreurs.js";

// Lecture des journaux regroupés par la console (A-080, C-022) : VictoriaLogs, réseau interne, lecture seule.
// La requête LogsQL est construite côté serveur à partir d'un code FERMÉ (api, executeur, console) : aucune chaîne de l'appelant n'y entre.
// Les dates (validées par Zod) ne vont que dans des paramètres de formulaire, jamais dans le texte de la requête.
// Chaque ligne relue est ramenée à la liste fermée de champs et MASQUÉE DE NOUVEAU : un collecteur trop bavard ne fuit pas par cette route.
// Limite connue (garde non exhaustive par nature, règle 9.4) : les motifs de masquage ne couvrent pas toute forme de secret ; le rempart est la liste fermée, la borne de 500 caractères et le masqueur des secrets injecté.

export const BRIQUES = ["api", "executeur", "console"] as const;
export type Brique = (typeof BRIQUES)[number];
export const LIMITE_LIGNES = 500;
export const BORNE_MESSAGE = 500;
export const RETENTION_JOURS = 30;
const DELAI_MS = 5000;
const OCTETS_MAX = 2_000_000;
const JOUR_MS = 86_400_000;

export interface FiltreLecture { brique: Brique; depuis: Date; jusqua?: Date }
export interface LigneLue { heure: string; niveau: string; application: string; message: string; code?: string; reqId?: string; tenant?: string }
export type FetchLecture = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ status: number; text(): Promise<string> }>;
export interface DepsLecture {
  // Adresse de base du collecteur, réseau interne.
  url: string;
  fetch?: FetchLecture;
  masquerSecrets?: (texte: string) => string;
  maintenant?: () => number;
}

const Requete = z.strictObject({ brique: z.enum(BRIQUES), depuis: z.iso.datetime(), jusqua: z.iso.datetime().optional() });

export function validerFiltre(brut: unknown, maintenant: number): FiltreLecture {
  const r = Requete.safeParse(brut);
  if (!r.success) throw new ErreurApi("schema_invalide", "Requête invalide.");
  const depuis = new Date(r.data.depuis);
  const jusqua = r.data.jusqua ? new Date(r.data.jusqua) : undefined;
  const hors = depuis.getTime() < maintenant - RETENTION_JOURS * JOUR_MS || depuis.getTime() > maintenant || (jusqua && (jusqua.getTime() <= depuis.getTime() || jusqua.getTime() > maintenant));
  if (hors) throw new ErreurApi("schema_invalide", "Période invalide.");
  return { brique: r.data.brique, depuis, ...(jusqua ? { jusqua } : {}) };
}

const chaine = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

function ligneFermee(brut: unknown, masquerSecrets: (t: string) => string): LigneLue | undefined {
  if (typeof brut !== "object" || brut === null) return undefined;
  const o = brut as Record<string, unknown>;
  const temps = chaine(o["_time"]);
  if (!temps || Number.isNaN(Date.parse(temps))) return undefined;
  const ligne: LigneLue = {
    heure: new Date(temps).toISOString(),
    niveau: masquerSecrets(masquer(chaine(o["niveau"]) ?? "info")).slice(0, 16),
    application: masquerSecrets(masquer(chaine(o["application"]) ?? "")).slice(0, 32),
    message: masquerSecrets(masquer(chaine(o["_msg"]) ?? "")).slice(0, BORNE_MESSAGE),
  };
  for (const cle of ["code", "reqId", "tenant"] as const) {
    const v = chaine(o[cle]);
    if (v && /^[A-Za-z0-9_.-]{1,64}$/.test(v) && masquerSecrets(masquer(v)) === v) ligne[cle] = v;
  }
  return ligne;
}

export async function lireJournaux(d: DepsLecture, f: FiltreLecture): Promise<LigneLue[]> {
  const envoyer = d.fetch ?? (globalThis.fetch as unknown as FetchLecture);
  const masquerSecrets = d.masquerSecrets ?? ((t: string) => t);
  const corps = new URLSearchParams({
    query: `{application="${f.brique}"} | sort by (_time) desc | limit ${LIMITE_LIGNES}`,
    limit: String(LIMITE_LIGNES),
    start: f.depuis.toISOString(),
    ...(f.jusqua ? { end: f.jusqua.toISOString() } : {}),
  });
  let texte: string;
  try {
    const r = await envoyer(`${d.url.replace(/\/+$/, "")}/select/logsql/query`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: corps.toString(), signal: AbortSignal.timeout(DELAI_MS) });
    if (r.status !== 200) throw new Error("collecteur");
    texte = (await r.text()).slice(0, OCTETS_MAX);
  } catch {
    // Aucun détail du collecteur (adresse, message) ne sort.
    throw new ErreurApi("porte_fermee", "Journaux indisponibles.");
  }
  const sortie: LigneLue[] = [];
  for (const brute of texte.split("\n")) {
    if (sortie.length >= LIMITE_LIGNES) break;
    if (!brute.trim()) continue;
    let json: unknown;
    try { json = JSON.parse(brute); } catch { continue; }
    const l = ligneFermee(json, masquerSecrets);
    if (l) sortie.push(l);
  }
  return sortie;
}
