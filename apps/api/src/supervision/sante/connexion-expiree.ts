// Connexion expirée (B-385) : reconnue dans le code d'erreur normalisé du connecteur (C4 révisé), jamais dans un texte libre.
// Liste fermée : un code absent d'ici n'est pas une connexion expirée.
export const CODES_CONNEXION_EXPIREE: ReadonlySet<string> = new Set(["invalid_grant", "connexion_rouge", "connexion_expiree"]);

export function estConnexionExpiree(code: string | null | undefined): boolean {
  return typeof code === "string" && CODES_CONNEXION_EXPIREE.has(code);
}
