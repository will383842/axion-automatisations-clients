import instantane from "./modele-base-client.json" with { type: "json" };

// Listes blanches du MODÈLE des bases clients : tables, colonnes, TYPE de chaque colonne, colonnes chiffrées, présence d'etablissement_id.
// Paquet pur : aucun accès disque. Le modèle vient d'un instantané commité (modele-base-client.json), généré depuis apps/api/drizzle-cli et comparé à lui par un test de l'API.
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

// Forme de l'instantané : listes de couples (jamais d'objet indexé par un nom), pour que __proto__ ne soit qu'une valeur.
export interface InstantaneModele { tables: [string, { canon: string; aEtablissement: boolean; colonnes: [string, ColonneModele][] }][]; chiffrees: string[] }

export function serialiserModele(m: Modele): InstantaneModele {
  return { tables: [...m.tables].map(([n, t]) => [n, { canon: t.canon, aEtablissement: t.aEtablissement, colonnes: [...t.colonnes] }]), chiffrees: [...m.chiffrees] };
}

export function chargerModele(i: InstantaneModele): Modele {
  const modele: Modele = {
    tables: new Map(i.tables.map(([n, t]) => [n, { canon: t.canon, aEtablissement: t.aEtablissement, colonnes: new Map(t.colonnes) }])),
    chiffrees: new Set(i.chiffrees),
  };
  // Sans modèle lisible, le module refuse de se charger (jamais de liste vide).
  if (modele.tables.size === 0) throw new Error("modèle des bases clients introuvable");
  return modele;
}

export const MODELE_BASE_CLIENT: Modele = chargerModele(instantane as InstantaneModele);
