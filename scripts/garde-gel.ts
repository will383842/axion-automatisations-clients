// Garde du gel pour litige (C-609) : tout fichier d'un chemin qui retire quelque chose et qui contient un appel de suppression
// doit aussi appeler exigerAucunGel ou gelActif. Analyse du texte, rien n'est exécuté.
export interface Fichier {
  chemin: string;
  contenu: string;
}
export const DOSSIERS_GARDES = ["retention", "sauvegardes", "export", "fin-de-contrat"] as const;
// Appels de suppression : liste de la fiche, plus retirerPartition (méthode du port de rétention qui détache et supprime la partition).
const SUPPRESSION = /\b(?:DROP|deleteObject|DeleteObjects\w*|detruireCleClient|drop_partition\w*|retirerPartition)\b/;
const VERIFICATION = /\b(?:exigerAucunGel|gelActif|retirerSousGel)\b/;
// Liste FERMÉE des exceptions, chacune avec sa raison. Vide : aucun fichier n'est dispensé (T2-39 et T2-42 n'existent pas encore).
export const EXCEPTIONS: readonly { chemin: string; raison: string }[] = [];

const GARDE = new RegExp(`(?:^|[\\\\/])apps[\\\\/]api[\\\\/]src[\\\\/](?:${DOSSIERS_GARDES.join("|")})[\\\\/]`);

export function verifierGel(fichiers: Fichier[]): string[] {
  const erreurs: string[] = [];
  for (const { chemin, contenu } of fichiers) {
    if (!GARDE.test(chemin) || /\.test\.ts$/.test(chemin) || EXCEPTIONS.some((e) => e.chemin === chemin)) continue;
    if (SUPPRESSION.test(contenu) && !VERIFICATION.test(contenu)) erreurs.push(`${chemin}: appel de suppression sans exigerAucunGel ni gelActif (gel pour litige, C-609)`);
  }
  return erreurs;
}
