import type { Forme, Parametre } from "@axion-auto/contrats/src/c4/forme.ts";
import type { Modele } from "./modele.js";

// Contrôles d'une forme qui dépendent du MODÈLE (extraits du superRefine de apps/api/src/donnees/requetes/structure.ts, sans changement) : table, colonnes lisibles, colonnes chiffrées,
// compatibilité du type des paramètres avec celui des colonnes, sommes numériques, limites. Les contrôles de pure forme sont ceux des schémas de C4 (contrats).
const IDENT = /^[a-z][a-z0-9_]{0,62}$/;
// Noms qui ne sont jamais ceux d'un alias, d'un paramètre ou d'une requête : membres de Object.prototype, mots du SQL, fonctions de lecture, noms réservés à la session.
const PROTOTYPE = new Set([...Object.getOwnPropertyNames(Object.prototype), "prototype", "__proto__"].map((n) => n.toLowerCase()));
const MOTS_SQL = new Set(["or", "and", "not", "is", "in", "null", "true", "false", "union", "intersect", "except", "exists", "between", "select", "from", "where", "join", "group", "having", "order", "limit", "offset", "case", "when", "with", "all", "any", "as", "like", "ilike", "distinct", "insert", "update", "delete", "drop", "alter", "create", "grant", "copy", "do", "set", "lateral", "values", "into", "for", "fetch", "over", "filter", "window", "on", "using", "user", "table", "row", "current_user", "etablissement_id", "etablissements", "ts_stat", "to_json", "to_jsonb", "row_to_json"]);
export const nomLibre = (n: string) => !PROTOTYPE.has(n.toLowerCase()) && !MOTS_SQL.has(n.toLowerCase()) && !/^(pg_|current_|set_config)|_to_(xml|json|jsonb)$/.test(n.toLowerCase());

const SANS_VALEUR = new Set<string>(["est_nul", "n_est_pas_nul"]);
const ENTIERS = new Set(["integer", "bigint", "smallint"]);
const NUMERIQUES = new Set(["integer", "bigint", "smallint", "numeric", "real", "double precision"]);
const COMPATIBLES: Record<Parametre["type"], (t: string) => boolean> = {
  uuid: (t) => t === "uuid", texte: (t) => t === "text", entier: (t) => ENTIERS.has(t), horodatage: (t) => t === "timestamp with time zone", liste_uuid: (t) => t === "uuid",
};

type Filtres = Extract<Forme, { type: "simple" }>["filtres"];
type Agregat = Extract<Forme, { type: "composee" }>["parties"][number]["agregat"];

export interface ResultatForme {
  refus: string[]; // messages de refus ; vide = forme acceptée
  rendues: string[]; // colonnes rendues, dans l'ordre
  agregats: boolean; // la sortie n'a que des agrégats
  utilises: ReadonlySet<string>; // paramètres cités par la forme
}

export function verifierForme(f: Forme, parametres: Readonly<Record<string, Parametre>>, modele: Modele): ResultatForme {
  const refus: string[] = [];
  const utilises = new Set<string>();
  const parametre = (n: string): Parametre | undefined => (Object.hasOwn(parametres, n) ? parametres[n] : undefined);
  const table = (nom: string) => { if (modele.tables.get(nom)?.aEtablissement !== true) refus.push("table non déclarable"); };
  const colonneLisible = (tableNom: string, nom: string) => {
    const def = modele.tables.get(tableNom)?.colonnes.get(nom);
    if (!def || def.chiffree || nom === "etablissement_id") { refus.push(`colonne refusée : ${nom}`); return undefined; }
    return def;
  };
  const aliasOk = (a: string) => { if (!IDENT.test(a) || !nomLibre(a) || modele.chiffrees.has(a)) refus.push(`alias refusé : ${a}`); };
  const filtres = (tableNom: string, liste: Filtres) => {
    for (const x of liste ?? []) {
      const def = colonneLisible(tableNom, x.colonne);
      if (SANS_VALEUR.has(x.operateur)) { if (x.parametre !== undefined) refus.push("paramètre inutile pour est_nul"); continue; }
      const p = x.parametre === undefined ? undefined : parametre(x.parametre);
      if (!p || !def) { refus.push("paramètre de filtre absent ou non déclaré"); continue; }
      utilises.add(x.parametre!);
      if ((x.operateur === "dans") !== (p.type === "liste_uuid") || !COMPATIBLES[p.type](def.type)) refus.push(`paramètre incompatible avec la colonne ${x.colonne}`);
    }
  };
  const agregat = (tableNom: string, a: Agregat) => {
    aliasOk(a.alias);
    if (a.fonction === "somme") {
      const def = colonneLisible(tableNom, a.colonne);
      if (def && !NUMERIQUES.has(def.type)) refus.push("somme sur colonne non numérique");
    }
  };

  if (f.type === "composee") {
    const alias = new Set<string>();
    for (const part of f.parties) {
      table(part.table);
      if (part.alias !== part.agregat.alias) refus.push("alias de partie et d'agrégat différents");
      alias.add(part.alias);
      agregat(part.table, part.agregat);
      filtres(part.table, part.filtres);
    }
    if (alias.size !== f.parties.length) refus.push("alias de parties répétés");
    return { refus, rendues: f.parties.map((p) => p.alias), agregats: true, utilises };
  }
  table(f.table);
  const agr = "agregats" in f.sortie;
  let rendues: string[];
  if ("agregats" in f.sortie) {
    for (const a of f.sortie.agregats) agregat(f.table, a);
    rendues = f.sortie.agregats.map((a) => a.alias);
  } else {
    rendues = f.sortie.lignes.map((l) => { colonneLisible(f.table, l.colonne); if (l.alias !== undefined) aliasOk(l.alias); return l.alias ?? l.colonne; });
  }
  if (new Set(rendues).size !== rendues.length) refus.push("colonnes rendues répétées");
  filtres(f.table, f.filtres);
  for (const t of f.tri ?? []) colonneLisible(f.table, t.colonne);
  if (agr && f.tri?.length) refus.push("tri avec agrégats");
  if (agr && f.limite) refus.push("limite avec agrégats");
  if (!agr && !f.limite) refus.push("limite obligatoire sur des lignes");
  if (f.limite && "parametre" in f.limite) {
    const p = parametre(f.limite.parametre);
    if (p?.type !== "entier" || p.min < 1 || p.max > 200) refus.push("paramètre de limite hors bornes 1..200");
    else utilises.add(f.limite.parametre);
  }
  return { refus, rendues, agregats: agr, utilises };
}
