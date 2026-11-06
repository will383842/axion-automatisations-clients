import { genererSql as genererSqlPaquet, type SqlGenere } from "@axion-auto/donnees-module";
import { MODELE } from "./modele.js";
import type { FormeDeclaree, RequeteDeclaree } from "./structure.js";

// Couche mince (T4-50b) : le seul producteur de SQL est le paquet @axion-auto/donnees-module (generer.ts). Ici : le modèle des bases clients et les paramètres de la requête.
export type { SqlGenere };
export function genererSql(r: RequeteDeclaree, valeurs: Record<string, unknown>, etablissements: readonly string[], forme: FormeDeclaree = r.forme): SqlGenere {
  return genererSqlPaquet(forme, r.parametres, valeurs, etablissements, MODELE);
}
