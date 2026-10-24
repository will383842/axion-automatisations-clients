import { z } from "zod";
// Lecture d'une entreprise du CRM : GET /api/console/v1/entreprises?siren= ou ?siret= (exactement un des deux).
export const CHEMIN_LECTURE = "/api/console/v1/entreprises";
const luhn = (s: string) => {
  let somme = 0;
  [...s].reverse().forEach((c, i) => {
    let d = Number(c);
    if (i % 2 === 1 && (d *= 2) > 9) d -= 9;
    somme += d;
  });
  return somme % 10 === 0;
};
// SIREN : 9 chiffres et contrôle de Luhn. SIRET : 14 chiffres.
export const Siren = z.string().regex(/^[0-9]{9}$/).refine(luhn, "SIREN invalide");
export const Siret = z.string().regex(/^[0-9]{14}$/);
const Texte = z.string().min(1);
export const Adresse = z.strictObject({ ligne1: Texte, ligne2: Texte.optional(), codePostal: Texte, ville: Texte, pays: z.literal("FR") });
export const LectureRequete = z.union([z.strictObject({ siren: Siren }), z.strictObject({ siret: Siret })]);
// Les champs foreign_id et external_ref du CRM ne font pas partie du contrat : le schéma strict les refuse.
export const LectureReponse = z.strictObject({
  crmCompanyId: Texte,
  raisonSociale: Texte,
  adresse: Adresse,
  siretEtablissement: Siret,
  // Présent seulement pour une fiche absorbée : identifiant de la fiche gardée (200, pas 404).
  absorbeePar: Texte.optional(),
});
export type LectureReponse = z.infer<typeof LectureReponse>;
