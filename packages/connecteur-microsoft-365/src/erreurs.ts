import { ErreurConnecteur } from "@axion-auto/connecteurs-commun";

// Quand Graph limite sans dire jusqu'à quand : on attend une minute (une date est exigée par le noyau).
const REPRISE_PAR_DEFAUT_MS = 60_000;

// Retry-After : un nombre de secondes ou une date HTTP. Renvoie une date ISO, ou rien si illisible.
export function reprise(entete: string | null, maintenant: number): string | undefined {
  if (!entete) return undefined;
  const ms = /^\d+$/.test(entete.trim()) ? Number(entete) * 1000 : Date.parse(entete) - maintenant;
  return Number.isFinite(ms) ? new Date(maintenant + Math.max(0, ms)).toISOString() : undefined;
}

// Classe une réponse d'échec de Graph. Le texte de la réponse sert à reconnaître un code, jamais à être recopié.
export function erreurDeReponse(statut: number, entetes: Headers, texte: string, maintenant: number): ErreurConnecteur {
  if (texte.includes("AADSTS65001")) return new ErreurConnecteur("identification", "consentement_requis");
  if (statut === 401 || texte.includes("invalid_grant")) return new ErreurConnecteur("identification", "jeton_refuse");
  const date = reprise(entetes.get("retry-after"), maintenant);
  if (statut === 429) return new ErreurConnecteur("quota", "quota_depasse", { reprise: date ?? new Date(maintenant + REPRISE_PAR_DEFAUT_MS).toISOString() });
  if (statut === 503 && date) return new ErreurConnecteur("quota", "quota_depasse", { reprise: date });
  if (statut >= 500) return new ErreurConnecteur("passagere", `http_${statut}`);
  return new ErreurConnecteur("definitive", `http_${statut}`);
}
