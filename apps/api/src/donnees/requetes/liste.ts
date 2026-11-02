import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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
// Liste FERMÉE des colonnes chiffrées, lue dans le modèle des bases clients (migrations drizzle-cli) : toute colonne binaire (bytea), tout nom en _chiffre ou _empreinte,
// et « empreinte ». Une colonne ajoutée au modèle entre donc d'elle-même dans la liste ; sans modèle lisible, le module refuse de se charger (jamais de liste vide).
function colonnesChiffreesDuModele(): ReadonlySet<string> {
  const dossier = fileURLToPath(new URL("../../../drizzle-cli/", import.meta.url));
  const fichiers = readdirSync(dossier).filter((f) => f.endsWith(".sql"));
  if (fichiers.length === 0) throw new Error("modèle des bases clients introuvable");
  const noms = new Set<string>(["empreinte"]);
  for (const f of fichiers) {
    const texte = readFileSync(`${dossier}${f}`, "utf8");
    for (const m of texte.matchAll(/^\s*"([a-z_0-9]+)"\s+"?(\w+)"?/gm)) {
      const [, nom = "", type = ""] = m;
      if (type.toLowerCase() === "bytea" || /(_chiffre|_empreinte)$/.test(nom) || nom === "empreinte") noms.add(nom);
    }
  }
  return noms;
}
export const COLONNES_CHIFFREES: ReadonlySet<string> = colonnesChiffreesDuModele();
const mot = (nom: string) => new RegExp(`(?<![A-Za-z0-9_])"?${nom}"?(?![A-Za-z0-9_])`, "i");

// Refuse à la déclaration : filtre sans emplacement (ou l'inverse), nom qui ne suit pas sa clé, colonne chiffrée rendue ou nommée dans le texte SQL (alias, étoile compris),
// alias hors des colonnes rendues, filtre ailleurs qu'après WHERE ou AND, et OR dans une requête filtrée (un OR pourrait défaire le filtre d'établissement).
export function verifierListeBlanche(liste: Record<string, Requete>): void {
  for (const [cle, r] of Object.entries(liste)) {
    if (r.nom !== cle || !NOM.test(cle)) throw new Error(`requête mal nommée : ${cle}`);
    if (r.sql.includes(EMPLACEMENT_FILTRE) !== r.parEtablissement) throw new Error(`filtre d'établissement incohérent : ${cle}`);
    if (r.colonnes.some((c) => COLONNES_CHIFFREES.has(c) || /_chiffre$|_empreinte$/.test(c))) throw new Error(`colonne chiffrée rendue : ${cle}`);
    if (r.mode === "ecriture" && r.metadonnees) throw new Error(`écriture déclarée métadonnée : ${cle}`);
    const texte = r.sql.replaceAll(EMPLACEMENT_FILTRE, " ");
    for (const c of COLONNES_CHIFFREES) if (mot(c).test(texte)) throw new Error(`colonne chiffrée nommée dans le SQL : ${cle}`);
    if (/\bselect\s+(distinct\s+)?\*|,\s*\*|\.\*/i.test(texte)) throw new Error(`étoile dans le SQL : ${cle}`);
    for (const m of texte.matchAll(/\bAS\s+"?([A-Za-z_][A-Za-z0-9_]*)"?/gi)) if (!r.colonnes.includes(m[1] ?? "")) throw new Error(`alias hors des colonnes rendues : ${cle}`);
    if (r.parEtablissement) {
      if (/\bOR\b/i.test(texte)) throw new Error(`OR dans une requête filtrée : ${cle}`);
      const total = r.sql.split(EMPLACEMENT_FILTRE).length - 1;
      const bien = (r.sql.match(/\b(?:WHERE|AND)\s+\{\{filtre\}\}(?![\w(])/gi) ?? []).length;
      if (total !== bien) throw new Error(`filtre mal placé : ${cle}`);
    }
  }
}

export const LISTE_BLANCHE: Readonly<Record<string, Requete>> = Object.freeze(premieresRequetes());
verifierListeBlanche(LISTE_BLANCHE);
