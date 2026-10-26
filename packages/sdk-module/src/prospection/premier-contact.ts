import { z } from "zod";

const JOUR = 86_400_000;
export const DELAI_INFORMATIONS_JOURS = 30;

export type PlanInformations =
  | { mode: "avec_premier_message" }
  | { mode: "planifie"; auPlusTard: string; enRetard: boolean };

// Dates au format AAAA-MM-JJ. Les informations partent avec le premier message, sinon au plus
// tard 30 jours après l'obtention de la donnée.
export function planifierInformations(e: { dateObtention: string; informationsDansPremierMessage: boolean; maintenant: string }): PlanInformations {
  if (e.informationsDansPremierMessage) return { mode: "avec_premier_message" };
  if (!z.iso.date().safeParse(e.dateObtention).success || !z.iso.date().safeParse(e.maintenant).success) throw new Error("premier contact : date invalide");
  const obtention = Date.parse(`${e.dateObtention}T00:00:00Z`);
  const maintenant = Date.parse(`${e.maintenant}T00:00:00Z`);
  const echeance = obtention + DELAI_INFORMATIONS_JOURS * JOUR;
  return { mode: "planifie", auPlusTard: new Date(echeance).toISOString().slice(0, 10), enRetard: maintenant > echeance };
}
