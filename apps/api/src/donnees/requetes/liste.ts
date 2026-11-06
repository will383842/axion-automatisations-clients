import { genererSql, type SqlGenere } from "./generer.js";
import { premieresRequetes } from "./premieres.js";
import { declarer, schemaParametres, type RequeteDeclaree } from "./structure.js";

export { COLONNES_CHIFFREES } from "./modele.js";

// Liste blanche des requêtes du service des données (A-170, B-172, B-173). Une requête = une STRUCTURE validée par un schéma strict (structure.ts) ; aucun texte SQL n'en fait partie.
// Le SQL est produit par generer.ts, et par lui seul. Les listes de tables et de colonnes viennent du modèle des bases clients (modele.ts).
export type Requete = RequeteDeclaree;

// Les numéros $n du texte vont de 1 à N sans trou et N est le nombre de valeurs : contrôlé à la déclaration, pas seulement à l'exécution (B-173).
export function numerosCoherents(g: Pick<SqlGenere, "texte" | "valeurs">): boolean {
  const numeros = new Set([...g.texte.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));
  return numeros.size === g.valeurs.length && [...numeros].every((n) => n >= 1 && n <= g.valeurs.length);
}

// Valide chaque entrée par le schéma, vérifie que son nom est sa clé, et génère à blanc la requête et chacune de ses variantes (une erreur du générateur arrête le chargement).
export function verifierListeBlanche(liste: Readonly<Record<string, unknown>>): Record<string, Requete> {
  const sortie: Record<string, Requete> = {};
  for (const cle of Object.keys(liste)) {
    const r = declarer(liste[cle]);
    if (r.nom !== cle) throw new Error(`requête mal nommée : ${cle}`);
    const valeurs: Record<string, unknown> = {};
    for (const n of Object.keys(r.parametres)) {
      const p = r.parametres[n]!;
      valeurs[n] = p.type === "uuid" ? "00000000-0000-4000-8000-000000000000" : p.type === "texte" ? "a" : p.type === "entier" ? p.min : p.type === "horodatage" ? "2026-01-01T00:00:00Z" : [];
    }
    const blanc = schemaParametres(r).parse(valeurs) as Record<string, unknown>;
    for (const forme of [r.forme, ...(r.variantes ?? []).map((v) => v.forme)]) {
      if (!numerosCoherents(genererSql(r, blanc, [], forme))) throw new Error(`numéros $n incohérents : ${cle}`);
    }
    sortie[cle] = r;
  }
  return sortie;
}

export const LISTE_BLANCHE: Readonly<Record<string, Requete>> = Object.freeze(verifierListeBlanche(premieresRequetes()));
