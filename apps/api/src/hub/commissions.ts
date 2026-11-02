import { luhn } from "../../../../packages/contrats/src/commun/regles-fond.ts";

// A-147 : garde de code AVANT toute écriture d'une commission due (ADR 0053 point 10). Une commission non nulle exige un SIREN
// de neuf chiffres à clé de Luhn valide ET une vérification faite. Le solde peut être négatif (créance sur l'apporteur).
// Dettes en base (résultat et durée de validité de la vérification, CHECK signé) : LOT2-dette-T2-15-adr0053-*, propriétaire T2-52.
export type RefusCommission = "siren_absent" | "siren_luhn" | "siren_non_verifie" | "montant_invalide";
export function verifierCommission(c: { siren: string | null; sirenActifVerifieLe: Date | null; commissionsDuesCentimes: number }): { ok: true } | { ok: false; raison: RefusCommission } {
  if (!Number.isSafeInteger(c.commissionsDuesCentimes)) return { ok: false, raison: "montant_invalide" };
  if (c.commissionsDuesCentimes === 0) return { ok: true };
  if (c.siren === null || c.siren === "") return { ok: false, raison: "siren_absent" };
  if (!/^[0-9]{9}$/.test(c.siren) || !luhn(c.siren)) return { ok: false, raison: "siren_luhn" };
  if (c.sirenActifVerifieLe === null) return { ok: false, raison: "siren_non_verifie" };
  return { ok: true };
}
