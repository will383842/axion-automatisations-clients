import type { EtatSante } from "./etat.js";

// État d'un client (A-027) = le pire de ses instances ; comptes des clients par état (B-488).
export type EtatClient = EtatSante | "inconnue";
const GRAVITE: Record<EtatSante, number> = { vert: 0, orange: 1, rouge: 2 };

export function etatClient(instances: EtatSante[]): EtatClient {
  let pire: EtatSante | null = null;
  for (const e of instances) if (pire === null || GRAVITE[e] > GRAVITE[pire]) pire = e;
  return pire ?? "inconnue";
}

export function compterClients(parClient: Record<string, EtatSante[]>): Record<EtatClient, number> {
  const c: Record<EtatClient, number> = { vert: 0, orange: 0, rouge: 0, inconnue: 0 };
  for (const instances of Object.values(parClient)) c[etatClient(instances)] += 1;
  return c;
}
