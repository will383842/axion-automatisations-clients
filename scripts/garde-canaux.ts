// Garde des canaux (C-510) : toute route sous /api/hub/, /api/crm/ ou /api/executeur/ passe par enregistrerCanal,
// et aucun fichier de l'API n'écrit vers api/mcp ni site-sync d'axion-ia. Recherche de chemins dans le texte, rien n'est exécuté.
export interface Fichier {
  chemin: string;
  contenu: string;
}

const ROUTE_CANAL = /\/api\/(?:hub|crm|executeur)\/|\bPREFIXE_[A-Z0-9_]+\b/;
// Seuls fichiers qui portent les préfixes sans déclarer de route.
const FICHIERS_CANAUX = /(?:^|[\\/])apps[\\/]api[\\/]src[\\/]canaux[\\/](?:signer|verifier-entrant|journal-canal)\.ts$/;
const GREFFON = /\benregistrerCanal\s*\(/;
const CIBLE_AXION_IA = /api\/mcp|site-sync/;
const ECRITURE = /\b(?:post|put|patch|delete)\b/i;

export function verifierCanaux(fichiers: Fichier[]): string[] {
  const erreurs: string[] = [];
  for (const { chemin, contenu } of fichiers) {
    // Les tests construisent exprès de mauvais cas ; trois fichiers nommés portent les préfixes sans déclarer de route.
    if (/\.test\.ts$/.test(chemin) || FICHIERS_CANAUX.test(chemin)) continue;
    if (ROUTE_CANAL.test(contenu) && !GREFFON.test(contenu)) erreurs.push(`${chemin}: route sous /api/hub/, /api/crm/, /api/executeur/ ou un préfixe PREFIXE_* sans enregistrerCanal`);
    if (CIBLE_AXION_IA.test(contenu) && ECRITURE.test(contenu)) erreurs.push(`${chemin}: appel en écriture à api/mcp ou site-sync d'axion-ia`);
  }
  return erreurs;
}
