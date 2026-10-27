import { ErreurConnecteur } from "@axion-auto/connecteurs-commun";

// Quand Gmail limite sans dire jusqu'à quand : on attend une minute (une date est exigée par le noyau).
const REPRISE_PAR_DEFAUT_MS = 60_000;

// Retry-After : un nombre de secondes ou une date HTTP. Renvoie une date ISO, ou rien si illisible.
export function reprise(entete: string | null, maintenant: number): string | undefined {
  if (!entete) return undefined;
  const ms = /^\d+$/.test(entete.trim()) ? Number(entete) * 1000 : Date.parse(entete) - maintenant;
  return Number.isFinite(ms) ? new Date(maintenant + Math.max(0, ms)).toISOString() : undefined;
}

// Classe une réponse d'échec de Gmail. Le texte de la réponse sert à reconnaître un code, jamais à être recopié.
export function erreurDeReponse(statut: number, entetes: Headers, texte: string, maintenant: number): ErreurConnecteur {
  // L'administrateur du client a bloqué l'application interne (ou l'API n'y est pas activée) : il faut un humain chez le client.
  if (texte.includes("admin_policy_enforced") || texte.includes("accessNotConfigured")) {
    return new ErreurConnecteur("identification", "application_bloquee_par_administrateur");
  }
  if (statut === 401 || texte.includes("invalid_grant")) return new ErreurConnecteur("identification", "jeton_refuse");
  if (statut === 429 || texte.includes("rateLimitExceeded")) {
    const date = reprise(entetes.get("retry-after"), maintenant) ?? new Date(maintenant + REPRISE_PAR_DEFAUT_MS).toISOString();
    return new ErreurConnecteur("quota", "quota_depasse", { reprise: date });
  }
  if (statut >= 500) return new ErreurConnecteur("passagere", `http_${statut}`);
  return new ErreurConnecteur("definitive", `http_${statut}`);
}
