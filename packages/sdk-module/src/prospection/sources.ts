import { z } from "zod";

// Rubrique du manifeste d'un module de prospection : d'où vient chaque liste.
export const BASES_LEGALES = ["consentement", "contrat", "interet_legitime", "obligation_legale"] as const;

// linkedin.com et ses variantes (sous-domaines, point final, autres extensions), lnkd.in.
const estLinkedIn = (texte: string) => /linkedin|lnkd\.in/i.test(texte);

const Source = z
  .object({
    nom: z.string().trim().min(1),
    domaine: z.string().trim().min(1).optional(),
    baseLegale: z.enum(BASES_LEGALES),
    dateObtention: z.iso.date(),
  })
  .strict()
  .refine((s) => !estLinkedIn(s.nom) && !estLinkedIn(s.domaine ?? ""), "source LinkedIn interdite");

export type SourceDeclaree = z.input<typeof Source>;

export function sourcesDeclarees(sources: readonly SourceDeclaree[]): readonly z.output<typeof Source>[] {
  if (sources.length === 0) throw new Error("module de prospection : au moins une source déclarée");
  return Object.freeze(sources.map((s) => Source.parse(s)));
}
