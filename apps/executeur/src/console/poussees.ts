import { z } from "zod";
import { Identifiant } from "@axion-auto/contrats/src/c4/configuration.ts";
import type { CacheReglages } from "./cache.ts";
import type { GardeEtatVoulu } from "./etat-voulu.ts";

// Canal Valkey par cellule (même forme que apps/api/src/executeur/poussees.ts).
export const canalPoussees = (cellule: string): string => `executeur:poussees:${cellule}`;

const Poussee = z.object({ type: z.enum(["pause", "reprise", "revocation", "arret_envois"]), instanceId: Identifiant }).strict();

// Vrai si le message est valide et appliqué. Un message mal formé est ignoré : l'état voulu relu à chaque exécution reste la référence.
export function appliquerPoussee(brut: string, o: { garde: GardeEtatVoulu; cache: CacheReglages<unknown> }): boolean {
  let json: unknown;
  try {
    json = JSON.parse(brut);
  } catch {
    return false;
  }
  const p = Poussee.safeParse(json);
  if (!p.success) return false;
  const { type, instanceId } = p.data;
  if (type === "pause") o.garde.appliquer(instanceId, { etat: "pause" });
  else if (type === "reprise") o.garde.appliquer(instanceId, { etat: "actif", arretEnvois: false });
  else if (type === "arret_envois") o.garde.appliquer(instanceId, { arretEnvois: true });
  o.cache.vider(instanceId); // pause, reprise, révocation, arrêt : les réglages sont relus
  return true;
}

export interface Abonnement {
  subscribe(canal: string): Promise<unknown>;
  on(evenement: "message", cb: (canal: string, message: string) => void): unknown;
}
export async function ecouterPoussees(abonnement: Abonnement, cellule: string, o: { garde: GardeEtatVoulu; cache: CacheReglages<unknown> }): Promise<void> {
  const canal = canalPoussees(cellule);
  abonnement.on("message", (c, m) => {
    if (c === canal) appliquerPoussee(m, o);
  });
  await abonnement.subscribe(canal);
}
