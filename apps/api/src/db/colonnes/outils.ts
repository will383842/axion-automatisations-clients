import { is } from "drizzle-orm";
import { getTableConfig, PgDialect, PgTable } from "drizzle-orm/pg-core";
import * as schema from "../schema.ts";

// Aides des gardes de colonnes, déplacées sans changer une ligne de logique depuis garde-colonnes.test.ts (figé) : elles servent à ce fichier et au registre des fragments.
// Garde « aucun secret en base » (T2-06) : aucune colonne du schéma ne porte un nom de secret. Un secret vit dans le coffre ; la base ne garde qu'une référence.
export const INTERDITS = ["secret", "mot_de_passe", "password", "token", "jeton", "cle_api"];
// Liste fermée des colonnes de référence permises : chaque ajout se relit en 2 tours (zone sécurité).
export const PERMISES: readonly string[] = ["reference_coffre"];

export function colonnesInterdites(tables: PgTable[]): string[] {
  return tables.flatMap((t) => {
    const { name, columns } = getTableConfig(t);
    return columns.filter((c) => INTERDITS.some((m) => c.name.toLowerCase().includes(m)) && !PERMISES.includes(c.name)).map((c) => `${name}.${c.name}`);
  });
}
export const tablesDuSchema = () => Object.values(schema).filter((v) => is(v, PgTable)) as PgTable[];
// Garde « aucun texte libre » (C-034) : dans demandes, executions et alertes, toute colonne `text` figure dans une liste fermée avec sa longueur maximale,
// et le schéma porte un CHECK qui la borne (char_length(col) <= N, ou une expression régulière à quantificateur borné {m,n}). Un motif borné compte pour n + 1 caractères au plus (un caractère d'attaque possible avant la classe répétée). Chaque ajout se relit en 2 tours.
export const TEXTE_PERMIS: Readonly<Record<string, number>> = Object.freeze({
  "demandes.categorie": 64,
  "demandes.reference_texte": 64,
  "demandes.responsable": 200,
  "executions.code_erreur": 65,
  "alertes.type": 64,
  "alertes.regle": 64,
  // Soldées par la migration 0019 (T2-52, bornes validées en base).
  "executions.auteur": 200,
  "executions.termine_par": 200,
  "alertes.assignee_a": 200,
  // T3-05a (migration 0020) : « Aujourd'hui », colonnes bornées par expression régulière ou par char_length.
  "aujourdhui_ignores.type_fait": 65,
  "aujourdhui_ignores.reference": 129,
  "aujourdhui_ignores.membre": 200,
  // T3-05b (migration 0021) : conformité, références de forme fermée (aucun texte libre).
  "demandes_droits.reference": 64,
  "demandes_droits.reference_reponse": 129,
  "incidents_violations.reference": 64,
  "incidents_violations.reference_dossier": 129,
  "aipd.reference_document": 256,
  // T5-01b (migration 0023) : colonnes d'alertes, bornées par un motif (clé de regroupement 128, cause 64).
  "alertes.cle_regroupement": 128,
  "alertes.cause": 64,
});
// Dettes écrites (ADR 0055) : soldée par la migration 0019 (T2-52), qui borne executions.auteur, executions.termine_par et alertes.assignee_a. Liste fermée et vide : elle ne grandit pas.
export const TEXTE_SANS_LIMITE_DETTE: readonly string[] = Object.freeze([]);
export const sqlDe = (c: { value: Parameters<PgDialect["sqlToQuery"]>[0] }) => new PgDialect().sqlToQuery(c.value).sql;
export const borne = (verifs: string[], colonne: string): number | null => {
  let max: number | null = null;
  for (const v of verifs) {
    if (!v.includes(`"${colonne}"`)) continue;
    const l = /char_length\((?:"[a-z_]+"\.)?"[a-z_]+"\)(?: <=|\s+BETWEEN \d+ AND) (\d+)/.exec(v);
    if (l) max = Math.max(max ?? 0, Number(l[1]));
    else if (/\{\d+,(\d+)\}\$/.test(v)) max = Math.max(max ?? 0, Number(/\{\d+,(\d+)\}\$/.exec(v)?.[1]) + 1);
  }
  return max;
};
export function textesSansLimite(tables: PgTable[], permis: Readonly<Record<string, number>> = TEXTE_PERMIS, dette: readonly string[] = TEXTE_SANS_LIMITE_DETTE): string[] {
  return tables.flatMap((t) => {
    const { name, columns, checks } = getTableConfig(t);
    const verifs = checks.map(sqlDe);
    return columns
      .filter((c) => c.getSQLType() === "text")
      .flatMap((c) => {
        const cle = `${name}.${c.name}`;
        const max = borne(verifs, c.name);
        if (dette.includes(cle)) return max === null ? [] : [`${cle} : désormais bornée, la retirer de la dette`];
        if (!(cle in permis)) return [`${cle} : hors de la liste fermée`];
        if (max === null) return [`${cle} : aucune longueur maximale dans le schéma`];
        if (max > (permis[cle] ?? 0)) return [`${cle} : ${max} > ${permis[cle]}`];
        return [];
      });
  });
}
export const tableNommee = (nom: string) => tablesDuSchema().find((t) => getTableConfig(t).name === nom) as PgTable;
// Colonnes text[] : bornées en nombre ET en forme (dette M3 de l'audit de la 0022). Une colonne text[] hors de cette garde est refusée.
export function tableauxSansBorne(tables: PgTable[]): string[] {
  return tables.flatMap((t) => {
    const { name, columns, checks } = getTableConfig(t);
    const verifs = checks.map(sqlDe);
    return columns
      .filter((c) => c.getSQLType() === "text[]")
      .flatMap((c) => {
        const cle = `${name}.${c.name}`;
        const siennes = verifs.filter((v) => v.includes(`"${c.name}"`));
        const nombre = siennes.some((v) => new RegExp(`cardinality\\((?:"[a-z_]+"\\.)?"${c.name}"\\) <= \\d+`).test(v));
        const forme = siennes.some((v) => v.includes("array_to_string") && /\{\d+,\d+\}/.test(v));
        return [...(nombre ? [] : [`${cle} : nombre d'éléments non borné`]), ...(forme ? [] : [`${cle} : forme des éléments non bornée`])];
      });
  });
}
