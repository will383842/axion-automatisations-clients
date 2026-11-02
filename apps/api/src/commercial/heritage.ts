import { resoudre } from "@axion-auto/reglages-heritage";

// Héritage des valeurs commerciales (T2-08, A-160, C-138). La fonction de résolution est celle du paquet partagé (B-515) : on la réexporte, on n'en écrit pas une seconde.
// ARRONDI (règle écrite ici, testée sur les bornes 0, 1, 9999 et 10000) : aucun pourcentage en flottant. Une remise en points de base s'applique à un montant
// en centimes par `floor(montant × bps / 10000)` en bigint ; le montant restant est montant − remise. Le client ne gagne jamais un centime d'arrondi.
export { resoudre };

// Liste FERMÉE des clés héritables. Chaque type de `conditions_commerciales.type` (énumération type_condition) en porte au moins une, et une clé n'a qu'un type.
export const TYPE_VERS_CLES = Object.freeze({
  remise: ["remise_bps"],
  frais: ["frais_mise_en_place_centimes", "tarif_mensuel_centimes"],
  engagement: ["engagement_mois", "maintenance_incluse_mois", "suite_maintenance"],
  garantie: ["garantie_mois"],
  delai: ["delai_jours"],
  seuil_alerte: ["seuil_alerte_bps"],
  periode: ["periode_facturation_mois", "mode_avance"],
} as const);
export type TypeCondition = keyof typeof TYPE_VERS_CLES;
export const CLES_HERITABLES = Object.freeze(Object.values(TYPE_VERS_CLES).flat());
export type CleHeritable = (typeof CLES_HERITABLES)[number];
export const estHeritable = (cle: string): cle is CleHeritable => (CLES_HERITABLES as readonly string[]).includes(cle);

// L'instance ne surcharge que des réglages sans argent : jamais un prix, des frais, une remise, un engagement, une période.
export const CLES_SURCHARGEABLES_INSTANCE: readonly CleHeritable[] = Object.freeze(["garantie_mois", "delai_jours", "seuil_alerte_bps"] as const);

export const MAX_ENTIER = Number.MAX_SAFE_INTEGER;
const entierSur = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

export function remiseBps(montantCentimes: number, bps: number): number {
  if (!entierSur(montantCentimes)) throw new Error("montant hors bornes (entier de 0 à 2^53 − 1)");
  if (!entierSur(bps) || bps > 10000) throw new Error("taux hors bornes (entier de 0 à 10000 points de base)");
  return Number((BigInt(montantCentimes) * BigInt(bps)) / 10000n);
}

// Motifs de refus du plan : message court, jamais une valeur de client ni un montant.
export class ErreurPlan extends Error {
  readonly code = "regle_metier";
  constructor(readonly motif: string) {
    super(motif);
  }
}
