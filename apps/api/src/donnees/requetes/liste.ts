import type { ZodType } from "zod";
import { premieresRequetes } from "./premieres.js";

// Liste blanche des requêtes du service des données (A-170, B-172). Une requête = un nom, un schéma de ses paramètres (les clés en trop sont écartées, jamais lues),
// un SQL paramétré écrit ici et nulle part ailleurs, un mode, les colonnes rendues (aucune colonne chiffrée : le déchiffrement explicite est celui de T2-33) et le filtre d'établissement.
// `{{filtre}}` est l'emplacement du filtre : le service le remplace par « etablissement_id = ANY($n::uuid[]) » à partir de la SESSION, jamais d'un paramètre (B-173).
export const EMPLACEMENT_FILTRE = "{{filtre}}";

export interface Requete {
  nom: string;
  schema: ZodType<unknown>;
  sql: string;
  mode: "lecture" | "ecriture";
  // Vrai : rien que des comptes ou des tailles, seule chose que l'équipe lit sans vue « comme le client » (B-070, C-006).
  metadonnees: boolean;
  parEtablissement: boolean;
  colonnes: readonly string[];
  valeurs(parametres: never): unknown[];
}

const NOM = /^[a-z][A-Za-z0-9]{0,63}$/;
// Refuse à la déclaration : filtre sans emplacement (ou l'inverse), nom qui ne suit pas sa clé, colonne chiffrée rendue.
export function verifierListeBlanche(liste: Record<string, Requete>): void {
  for (const [cle, r] of Object.entries(liste)) {
    if (r.nom !== cle || !NOM.test(cle)) throw new Error(`requête mal nommée : ${cle}`);
    if (r.sql.includes(EMPLACEMENT_FILTRE) !== r.parEtablissement) throw new Error(`filtre d'établissement incohérent : ${cle}`);
    if (r.colonnes.some((c) => /_chiffre$|_empreinte$/.test(c))) throw new Error(`colonne chiffrée rendue : ${cle}`);
    if (r.mode === "ecriture" && r.metadonnees) throw new Error(`écriture déclarée métadonnée : ${cle}`);
  }
}

export const LISTE_BLANCHE: Readonly<Record<string, Requete>> = Object.freeze(premieresRequetes());
verifierListeBlanche(LISTE_BLANCHE);
