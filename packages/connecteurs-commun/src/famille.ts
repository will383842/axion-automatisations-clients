import { z } from "zod";
import { ACTIONS, Capacite } from "./capacites.ts";

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export const INTERRUPTEUR = "CONNECTEURS_MESSAGERIE_OUVERT";

const Declaration = z
  .object({
    famille: z.string().min(1),
    outil: z.string().min(1),
    version: z.string().regex(SEMVER),
    capacites: z.array(Capacite).min(1),
    portees: z.array(z.string().min(1)),
  })
  .strict();
export type DeclarationConnecteur = z.infer<typeof Declaration>;

export function declarer(brut: unknown): DeclarationConnecteur {
  const d = Declaration.parse(brut);
  const permises = ACTIONS[d.famille];
  if (!permises) throw new Error(`famille inconnue : ${d.famille}`);
  const vues = new Set<string>();
  for (const { action } of d.capacites) {
    if (!permises.includes(action)) throw new Error(`action « ${action} » hors de la famille ${d.famille}`);
    if (vues.has(action)) throw new Error(`action « ${action} » déclarée deux fois`);
    vues.add(action);
  }
  return d;
}

// Ce que voit une automatisation : famille et actions génériques, jamais l'outil.
export const vueAutomatisation = (d: DeclarationConnecteur) => ({ famille: d.famille, actions: d.capacites.map((c) => c.action) });

// Fermé par défaut : seule la valeur « 1 » ouvre.
export const interrupteurOuvert = (env: Record<string, string | undefined>): boolean => env[INTERRUPTEUR] === "1";

export function activer(d: DeclarationConnecteur, env: Record<string, string | undefined>): DeclarationConnecteur {
  if (!interrupteurOuvert(env)) throw new Error(`interrupteur ${INTERRUPTEUR} fermé`);
  return d;
}
