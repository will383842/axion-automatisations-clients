import type { Forme, Parametre } from "@axion-auto/contrats/src/c4/forme.ts";
import type { ColonneModele, Modele, TableModele } from "./modele.js";

// Seul producteur de SQL du service des données (T2-37c, ADR 0109 ; paquet depuis T4-50b : le modèle est reçu en paramètre, sans variable globale). Aucune entrée textuelle libre : les identifiants sont ceux du MODÈLE (forme canonique entre guillemets doubles),
// jamais recopiés de l'objet ; les valeurs sont toutes liées ($n) ; le filtre d'établissement est posé ici, premier conjonct de chaque WHERE, avec les établissements de la SESSION.
const OPERATEURS: ReadonlyMap<string, string> = new Map([["egal", "="], ["different", "<>"], ["inferieur", "<"], ["inferieur_ou_egal", "<="], ["superieur", ">"], ["superieur_ou_egal", ">="]]);
const TRANSTYPAGE: Readonly<Record<Parametre["type"], string>> = { uuid: "::uuid", texte: "::text", entier: "::int8", horodatage: "::timestamptz", liste_uuid: "::uuid[]" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FILTRE_ETABLISSEMENT = '"etablissement_id" = ANY($1::uuid[])';

export interface SqlGenere { texte: string; valeurs: unknown[]; colonnes: string[] }

type Filtres = Extract<Forme, { type: "simple" }>["filtres"];

export function genererSql(forme: Forme, parametres: Readonly<Record<string, Parametre>>, valeurs: Record<string, unknown>, etablissements: readonly string[], modele: Modele): SqlGenere {
  if (!etablissements.every((e) => UUID.test(e))) throw new Error("établissement illisible");
  const envoyees: unknown[] = [[...etablissements]]; // $1 : établissements de la SESSION, partagé par toutes les parties
  const lier = (nom: string): string => {
    const p = Object.hasOwn(parametres, nom) ? parametres[nom] : undefined;
    if (!p || !Object.hasOwn(valeurs, nom) || valeurs[nom] === undefined) throw new Error("paramètre manquant");
    envoyees.push(valeurs[nom]);
    return `$${envoyees.length}${TRANSTYPAGE[p.type]}`;
  };
  const table = (cle: string): TableModele => {
    const t = modele.tables.get(cle);
    if (!t?.aEtablissement) throw new Error("table inconnue");
    return t;
  };
  const colonne = (t: TableModele, nom: string): ColonneModele => {
    const c = t.colonnes.get(nom);
    if (!c || c.chiffree || nom === "etablissement_id") throw new Error("colonne refusée");
    return c;
  };
  const sens = (s: string): string => {
    if (s === "asc") return "ASC";
    if (s === "desc") return "DESC";
    throw new Error("sens refusé");
  };
  const alias = (a: string): string => {
    if (!/^[a-z][a-z0-9_]{0,62}$/.test(a)) throw new Error("alias refusé");
    return `"${a}"`;
  };
  const conditions = (t: TableModele, a: string, filtres: Filtres): string => {
    let texte = `"${a}".${FILTRE_ETABLISSEMENT}`;
    for (const f of filtres ?? []) {
      const gauche = `"${a}".${colonne(t, f.colonne).canon}`;
      const op = OPERATEURS.get(f.operateur);
      if (f.operateur === "est_nul") texte += ` AND (${gauche} IS NULL)`;
      else if (f.operateur === "n_est_pas_nul") texte += ` AND (${gauche} IS NOT NULL)`;
      else if (f.operateur === "dans") texte += ` AND (${gauche} = ANY(${lier(f.parametre ?? "")}))`;
      else if (op) texte += ` AND (${gauche} ${op} ${lier(f.parametre ?? "")})`;
      else throw new Error("opérateur refusé");
    }
    return texte;
  };
  const agregat = (t: TableModele, a: string, g: { fonction: string; colonne?: string }): string => {
    if (g.fonction === "compter") return "count(*)::int";
    if (g.fonction === "somme") return `coalesce(sum("${a}".${colonne(t, g.colonne ?? "").canon}), 0)::float8`;
    throw new Error("agrégat refusé");
  };

  let texte: string;
  let colonnes: string[];
  if (forme.type === "composee") {
    const parties = forme.parties.map((p, i) => {
      const t = table(p.table);
      const a = `t${i + 1}`;
      return `(SELECT ${agregat(t, a, p.agregat)} FROM ${t.canon} AS "${a}" WHERE ${conditions(t, a, p.filtres)}) AS ${alias(p.alias)}`;
    });
    texte = `SELECT ${parties.join(", ")}`;
    colonnes = forme.parties.map((p) => p.alias);
  } else {
    const t = table(forme.table);
    const a = "t";
    let sortie: string;
    if ("agregats" in forme.sortie) {
      sortie = forme.sortie.agregats.map((g) => `${agregat(t, a, g)} AS ${alias(g.alias)}`).join(", ");
      colonnes = forme.sortie.agregats.map((g) => g.alias);
    } else {
      sortie = forme.sortie.lignes.map((l) => `"${a}".${colonne(t, l.colonne).canon} AS ${alias(l.alias ?? l.colonne)}`).join(", ");
      colonnes = forme.sortie.lignes.map((l) => l.alias ?? l.colonne);
    }
    texte = `SELECT ${sortie} FROM ${t.canon} AS "${a}" WHERE ${conditions(t, a, forme.filtres)}`;
    const tri = (forme.tri ?? []).map((o) => `"${a}".${colonne(t, o.colonne).canon} ${sens(o.sens)}`);
    // Ordre stable : l'identifiant en dernier, sauf s'il est déjà trié.
    if (tri.length && t.colonnes.has("id") && !(forme.tri ?? []).some((o) => o.colonne === "id")) tri.push(`"${a}"."id" ASC`);
    if (tri.length) texte += ` ORDER BY ${tri.join(", ")}`;
    if (forme.limite) {
      if ("parametre" in forme.limite) texte += ` LIMIT ${lier(forme.limite.parametre)}`;
      else { envoyees.push(forme.limite.fixe); texte += ` LIMIT $${envoyees.length}::int8`; }
    }
  }

  // Filet (pas la défense principale) : un invariant faux est une erreur de programmation, jamais une requête envoyée.
  const nombreTables = forme.type === "composee" ? forme.parties.length : 1;
  const numeros = new Set([...texte.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));
  const ok = numeros.size === envoyees.length && envoyees.every((_, i) => numeros.has(i + 1))
    && /^[\x20-\x7e]+$/.test(texte) && !/['\\;]|--|\/\*/.test(texte)
    && texte.split(FILTRE_ETABLISSEMENT).length - 1 === nombreTables;
  if (!ok) throw new Error("invariant du générateur violé");
  return { texte, valeurs: envoyees, colonnes };
}
