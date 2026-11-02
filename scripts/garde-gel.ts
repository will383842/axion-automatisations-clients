// Garde du gel pour litige (C-609) : tout fichier d'un chemin qui retire quelque chose et qui contient un appel de suppression
// doit aussi appeler exigerAucunGel, gelActif ou retirerSousGel. Analyse du texte, rien n'est exécuté ; les commentaires sont retirés d'abord.
// Limites connues (dette LOT2-dette-T2-43-appelants) : un appel de suppression écrit dans un autre dossier que ceux de la liste, ou construit
// dynamiquement, échappe à l'analyse ; un fichier qui vérifie le gel pour un autre chemin passe ; la garde ne prouve pas l'ordre des appels.
export interface Fichier {
  chemin: string;
  contenu: string;
}
export const DOSSIERS_GARDES = ["retention", "sauvegardes", "export", "fin-de-contrat"] as const;
// Appels de suppression : liste de la fiche, plus les formes de fichier, d'objet et de partition.
const SUPPRESSION_SQL = /\b(?:DROP|DELETE\s+FROM|TRUNCATE)\b/i;
const SUPPRESSION_APPEL = /\b(?:deleteObjects?|DeleteObjects?Command|DeleteObjects?|detruireCleClient|drop_partition\w*|retirerPartition|rmSync|unlink|rm)\b/;
const CLE_CLIENT = /\bdetruireCleClient\b/;
const VERIFICATION = /\b(?:exigerAucunGel|gelActif|retirerSousGel)\b/;
// fin-de-contrat : une mise à l'écart ne supprime rien mais retire l'accès ; ces mots la désignent.
const ECART = /\b(?:REVOKE|a_l_ecart|desactive)\b/i;
const EXPORTE_FONCTION = /\bexport\s+(?:async\s+)?(?:function\b|const\s+\w+\s*=\s*(?:async\s*)?(?:\(|function\b|\w+\s*=>))/;
// Liste FERMÉE des exceptions, chacune avec sa raison.
export const EXCEPTIONS: readonly { chemin: string; raison: string }[] = [
  { chemin: "apps/api/src/coffre/enveloppe.ts", raison: "définition de detruireCleClient : c'est l'appelant (T2-45) qui doit vérifier le gel avant d'appeler, la définition ne le peut pas" },
];

const GARDE = new RegExp(`(?:^|[\\\\/])apps[\\\\/]api[\\\\/]src[\\\\/](?:${DOSSIERS_GARDES.join("|")})[\\\\/]`);
const FIN_DE_CONTRAT = /(?:^|[\\/])apps[\\/]api[\\/]src[\\/]fin-de-contrat[\\/]/;
const SOUS_SRC = /(?:^|[\\/])apps[\\/]api[\\/]src[\\/]/;
const sansCommentaires = (c: string) => c.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:\\"'`])\/\/.*$/gm, "$1");

export function verifierGel(fichiers: Fichier[]): string[] {
  const erreurs: string[] = [];
  for (const { chemin, contenu } of fichiers) {
    if (!SOUS_SRC.test(chemin) || /\.test\.ts$/.test(chemin) || EXCEPTIONS.some((e) => chemin.endsWith(e.chemin))) continue;
    const code = sansCommentaires(contenu);
    const surveille = GARDE.test(chemin);
    const supprime = surveille ? SUPPRESSION_SQL.test(code) || SUPPRESSION_APPEL.test(code) : CLE_CLIENT.test(code);
    const ecart = FIN_DE_CONTRAT.test(chemin) && (EXPORTE_FONCTION.test(code) || ECART.test(code));
    if ((supprime || ecart) && !VERIFICATION.test(code)) erreurs.push(`${chemin}: appel de suppression ou de mise à l'écart sans exigerAucunGel ni gelActif (gel pour litige, C-609)`);
  }
  return erreurs;
}
