// Import de personnes (T2-47b) : seul chemin d'entrée de fichiers. verifierImport est appelé AVANT tout stockage ; un refus est validé (COMMIT) pour garder sa trace, puis l'erreur est renvoyée.
import type { Requeteur } from "../instances/activer.ts";
import { verifierImport } from "./donnees-interdites.ts";

export interface TransactionImport { client: Requeteur; valider(): Promise<void>; annuler(): Promise<void> }
// `ouvrir` ouvre une transaction dans la base du client de la session (jamais d'une URL ni du corps).
export interface PortsImport { ouvrir(): Promise<TransactionImport> }
export type SessionImport = { acteur: string; etablissementId: string };
export type FichierImport = { colonnes: string[]; lignes: Record<string, string>[] };

// La garde regarde les colonnes annoncées ET toutes les clés réellement présentes dans les lignes : une liste annoncée incomplète ne masque rien.
const colonnesVues = (f: FichierImport) => [...new Set([...f.colonnes, ...f.lignes.flatMap((l) => Object.keys(l))])];

export async function importerPersonnes(ports: PortsImport, session: SessionImport, fichier: FichierImport): Promise<{ importees: number }> {
  const tx = await ports.ouvrir();
  let termine = false;
  try {
    const verdict = await verifierImport(tx.client, session.acteur, colonnesVues(fichier));
    if (!verdict.accepte) {
      await tx.valider(); // la trace du refus survit : COMMIT, pas ROLLBACK
      termine = true;
      throw verdict.erreur;
    }
    // Seules les colonnes nom et prenom sont gardées ; une ligne déjà présente n'est jamais doublée (C-043).
    for (const l of fichier.lignes) {
      await tx.client.query(
        `INSERT INTO commun.personnes (etablissement_id, nom, prenom) SELECT $1, $2, $3
         WHERE NOT EXISTS (SELECT 1 FROM commun.personnes WHERE etablissement_id = $1 AND nom = $2 AND prenom IS NOT DISTINCT FROM $3)`,
        [session.etablissementId, l["nom"] ?? "", l["prenom"] ?? null],
      );
    }
    await tx.valider();
    termine = true;
    return { importees: fichier.lignes.length };
  } catch (e) {
    if (!termine) await tx.annuler();
    throw e;
  }
}
