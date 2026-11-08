import { parseSync } from "libpg-query";
import { analyserSql } from "../../../../scripts/garde-migrations.ts";
import { verifierMigrationModule } from "../donnees/migrer-base.js";

// Garde des migrations d'un module (T4-28b2, A-300, ADR 0125). Elle porte sur le TEXTE SQL, d'où qu'il vienne (instruction du manifeste v0 ou DDL généré plus tard) : elle reste valable après C4 0.6.0.
// Union de trois contrôles : (1) le filtre de texte de T2-35 ; (2) l'analyseur par arbre de la garde des migrations, avec une liste de fonctions permises VIDE ; (3) le refus des CREATE OR REPLACE VIEW,
// de tout CREATE FUNCTION / PROCEDURE et de CREATE RULE, que les deux premiers laissent passer. Aucune exception « contracter » : un module n'a que des migrations additives.
const MARQUEUR = "--> statement-breakpoint";
const CODE_MANIFESTE = /^[a-z][a-z0-9-]{1,62}$/;
const CODE_SCHEMA = /^[a-z][a-z0-9_]{1,30}$/;

// Code du manifeste (tirets, 63 caractères au plus) → code du schéma a_<code> de la base du client (soulignés, 31 caractères au plus). Refus, jamais de troncature : deux modules ne partagent jamais un schéma.
export function codeSchema(code: string): string {
  if (typeof code !== "string" || !CODE_MANIFESTE.test(code)) throw new Error("code de module invalide");
  const schema = code.replaceAll("-", "_");
  if (!CODE_SCHEMA.test(schema)) throw new Error("code de module trop long pour un schéma de base");
  return schema;
}

const PREFIXE = "migration de module refusée : ";
const REFUS_ARBRE: Record<string, (n: Record<string, unknown>) => string | undefined> = {
  ViewStmt: (n) => (n["replace"] === true ? "CREATE OR REPLACE VIEW" : undefined),
  CreateFunctionStmt: () => "CREATE FUNCTION ou PROCEDURE",
  RuleStmt: () => "CREATE RULE",
};
function parcourir(noeud: unknown, trouvees: Set<string>): void {
  if (Array.isArray(noeud)) return noeud.forEach((n) => parcourir(n, trouvees));
  if (!noeud || typeof noeud !== "object") return;
  for (const [cle, valeur] of Object.entries(noeud)) {
    const regle = REFUS_ARBRE[cle];
    const motif = regle && valeur && typeof valeur === "object" ? regle(valeur as Record<string, unknown>) : undefined;
    if (motif) trouvees.add(motif);
    parcourir(valeur, trouvees);
  }
}

// Rend un message par motif de refus, jamais un extrait du texte de la migration. Liste vide = acceptée.
export function verifierMigrationsModule(sqls: readonly string[], codeManifeste: string): string[] {
  let schema: string;
  try {
    schema = codeSchema(codeManifeste);
  } catch {
    return [`${PREFIXE}code de module invalide`];
  }
  const refus = new Set<string>();
  sqls.forEach((sql, i) => {
    for (const m of verifierMigrationModule(sql, schema)) refus.add(m);
    for (const m of analyserSql(`migration-${i}`, sql, [])) refus.add(PREFIXE + (m.includes("SQL illisible") ? "SQL illisible" : m.replace(/^.*?instruction interdite : /, "")));
    const trouvees = new Set<string>();
    for (const morceau of sql.split(MARQUEUR)) {
      if (!morceau.trim()) continue;
      try {
        parcourir(parseSync(morceau), trouvees);
      } catch {
        refus.add(`${PREFIXE}SQL illisible`);
      }
    }
    for (const t of trouvees) refus.add(PREFIXE + t);
  });
  return [...refus];
}
