import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Listes blanches lues dans le MODÈLE des bases clients (apps/api/drizzle-cli/*.sql) : tables, colonnes, TYPE de chaque colonne, colonnes chiffrées, présence d'etablissement_id.
// Les identifiants émis par le générateur (`canon`) viennent d'ici, jamais d'une requête. Maps et Sets uniquement : un nom comme __proto__ n'est membre de rien.
export interface ColonneModele { readonly type: string; readonly canon: string; readonly chiffree: boolean }
export interface TableModele { readonly canon: string; readonly colonnes: ReadonlyMap<string, ColonneModele>; readonly aEtablissement: boolean }
export interface Modele { readonly tables: ReadonlyMap<string, TableModele>; readonly chiffrees: ReadonlySet<string> }

// Colonne chiffrée : type binaire (bytea), nom en _chiffre ou _empreinte, et « empreinte ». Une colonne ajoutée au modèle entre d'elle-même dans la liste.
const estChiffree = (nom: string, type: string) => type === "bytea" || /(_chiffre|_empreinte)$/.test(nom) || nom === "empreinte";

export function analyserModele(sql: string): Modele {
  const tables = new Map<string, TableModele>();
  const chiffrees = new Set<string>(["empreinte"]);
  for (const m of sql.matchAll(/CREATE TABLE (?:"([a-z_0-9]+)"\.)?"([a-z_0-9]+)" \(\n([\s\S]*?)\n\);/g)) {
    const [, schema, table = "", corps = ""] = m;
    const colonnes = new Map<string, ColonneModele>();
    for (const c of corps.matchAll(/^\s*"([a-z_0-9]+)"\s+(.+)$/gm)) {
      const nom = c[1] ?? "";
      const type = (c[2] ?? "").replace(/,\s*$/, "").split(/\s+(?:PRIMARY|DEFAULT|NOT|NULL|CHECK|UNIQUE|REFERENCES|GENERATED)\b/i)[0]!.replaceAll('"', "").trim().toLowerCase();
      const chiffree = estChiffree(nom, type);
      if (chiffree) chiffrees.add(nom);
      colonnes.set(nom, { type, canon: `"${nom}"`, chiffree });
    }
    tables.set(schema ? `${schema}.${table}` : table, { canon: schema ? `"${schema}"."${table}"` : `"${table}"`, colonnes, aEtablissement: colonnes.has("etablissement_id") });
  }
  return { tables, chiffrees };
}

function chargerModele(): Modele {
  const dossier = fileURLToPath(new URL("../../../drizzle-cli/", import.meta.url));
  const fichiers = readdirSync(dossier).filter((f) => f.endsWith(".sql")).sort();
  const modele = analyserModele(fichiers.map((f) => readFileSync(`${dossier}${f}`, "utf8")).join("\n"));
  // Sans modèle lisible, le module refuse de se charger (jamais de liste vide).
  if (fichiers.length === 0 || modele.tables.size === 0) throw new Error("modèle des bases clients introuvable");
  return modele;
}
export const MODELE: Modele = chargerModele();
export const COLONNES_CHIFFREES: ReadonlySet<string> = MODELE.chiffrees;
