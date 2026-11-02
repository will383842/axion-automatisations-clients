import { z } from "zod";

// Limites de l'entrée d'une version (A-304) : l'archive est bornée avant et après décompression, le nombre de fichiers aussi.
export const LIMITES = Object.freeze({ archiveOctets: 20 * 1024 * 1024, decompresseOctets: 50 * 1024 * 1024, fichiers: 8 });

// Seuls ces fichiers entrent dans une archive (sortie de l'emballage T4-06 + signature T4-07). Tout autre nom est refusé.
export const FICHIERS_OBLIGATOIRES = ["module.js", "manifest.json", "sbom.cdx.json", "signature.json"] as const;
export const FICHIERS_PERMIS: ReadonlySet<string> = new Set([...FICHIERS_OBLIGATOIRES, "empreinte.sha256"]);

export type CodeRefus = "archive_invalide" | "module_non_signe" | "manifeste_invalide" | "licence_non_permise" | "provenance_interdite" | "contenu_interdit";

// Ce que la console lit de manifest.json (jamais le JavaScript du module). Mêmes règles de forme que defineAutomation (SDK) pour le code et la version.
// Les clés non listées (écrans, étapes, déclencheurs…) restent permises : leur contrôle complet tourne dans le bac à sable de la recette.
const CODE_MODULE = /^[a-z][a-z0-9-]{1,62}$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
export const ManifesteImporte = z.looseObject({
  code: z.string().regex(CODE_MODULE),
  version: z.string().regex(SEMVER),
  apiMoteur: z.string().regex(/\d/).max(100),
  connecteurs: z.array(z.looseObject({ famille: z.string().min(1) })),
  // Schéma JSON des réglages : un objet qui déclare la liste des actions automatiques autorisées (C-539).
  schemaReglages: z.looseObject({ type: z.literal("object"), properties: z.looseObject({ actionsAutomatiquesAutorisees: z.looseObject({}) }) }),
});
export type ManifesteImporte = z.infer<typeof ManifesteImporte>;

// Code stable de l'automatisation du catalogue (T2-03 : automatisations_code_format).
export const CodeAutomatisation = z.string().regex(/^[A-Z]{2,6}-[0-9]{3,5}$/);
