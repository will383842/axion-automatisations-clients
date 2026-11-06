import { readdirSync, readFileSync } from "node:fs";
import { is, sql } from "drizzle-orm";
import { check, getTableConfig, integer, PgDialect, PgTable, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { TABLES_COMMUNES } from "../../../../packages/contrats/src/c5/invariants.ts";
import { analyserSql } from "../../../../scripts/garde-migrations.ts";
import { TABLES_CLIENT } from "./schema/aides.ts";
import * as cli from "./schema-cli/index.ts";
import * as schema from "./schema.ts";

// Garde « aucun secret en base » (T2-06) : aucune colonne du schéma ne porte un nom de secret. Un secret vit dans le coffre ; la base ne garde qu'une référence.
const INTERDITS = ["secret", "mot_de_passe", "password", "token", "jeton", "cle_api"];
// Liste fermée des colonnes de référence permises : chaque ajout se relit en 2 tours (zone sécurité).
const PERMISES: readonly string[] = ["reference_coffre"];

export function colonnesInterdites(tables: PgTable[]): string[] {
  return tables.flatMap((t) => {
    const { name, columns } = getTableConfig(t);
    return columns.filter((c) => INTERDITS.some((m) => c.name.toLowerCase().includes(m)) && !PERMISES.includes(c.name)).map((c) => `${name}.${c.name}`);
  });
}
const tablesDuSchema = () => Object.values(schema).filter((v) => is(v, PgTable)) as PgTable[];

describe("garde des colonnes : aucun secret en base", () => {
  it("[LOT2-garde] aucune colonne du schéma réel n'est nommée comme un secret", () => {
    expect(tablesDuSchema().length).toBeGreaterThan(10);
    expect(colonnesInterdites(tablesDuSchema())).toEqual([]);
  });

  it("[C-034] aucune colonne des tables de schema-cli (bases des clients) n'est nommée comme un secret", () => {
    const tablesCli = Object.values(cli).filter((v) => is(v, PgTable)) as PgTable[];
    expect(tablesCli.length).toBe(9);
    expect(colonnesInterdites(tablesCli)).toEqual([]);
  });

  it("[LOT2-garde] la garde des colonnes refuse une colonne nommée comme un secret", () => {
    for (const nom of ["jeton_acces", "mot_de_passe_hash", "secret_client", "api_token", "cle_api_x", "Password"]) {
      const t = pgTable("essai_garde", { id: uuid("id"), [nom]: text(nom) });
      expect(colonnesInterdites([t]), nom).toEqual([`essai_garde.${nom}`]);
    }
    expect(colonnesInterdites([pgTable("essai_garde", { id: uuid("id"), reference_coffre: text("reference_coffre"), unites_ia: integer("unites_ia") })])).toEqual([]);
  });

  it("[LOT2-garde] la liste des colonnes permises est fermée : une seule référence au coffre", () => {
    expect(PERMISES).toEqual(["reference_coffre"]);
  });
});

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
});
// Dettes écrites (ADR 0055) : soldée par la migration 0019 (T2-52), qui borne executions.auteur, executions.termine_par et alertes.assignee_a. Liste fermée et vide : elle ne grandit pas.
export const TEXTE_SANS_LIMITE_DETTE: readonly string[] = Object.freeze([]);
const sqlDe = (c: { value: Parameters<PgDialect["sqlToQuery"]>[0] }) => new PgDialect().sqlToQuery(c.value).sql;
const borne = (verifs: string[], colonne: string): number | null => {
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
const tableNommee = (nom: string) => tablesDuSchema().find((t) => getTableConfig(t).name === nom) as PgTable;

describe("garde des colonnes : aucun texte libre (C-034)", () => {
  it("[C-034] demandes, executions et alertes : chaque colonne de texte est dans la liste fermée et bornée", () => {
    expect(textesSansLimite(["demandes", "executions", "alertes"].map(tableNommee))).toEqual([]);
  });

  it("[C-034] une colonne text sans limite de longueur est refusée ; une colonne bornée par char_length ou par un motif borné est acceptée", () => {
    const sans = pgTable("demandes", { id: uuid("id"), categorie: text("categorie") });
    expect(textesSansLimite([sans])).toEqual(["demandes.categorie : aucune longueur maximale dans le schéma"]);
    const libre = pgTable("alertes", { id: uuid("id"), message: text("message") });
    expect(textesSansLimite([libre])).toEqual(["alertes.message : hors de la liste fermée"]);
    const borne200 = pgTable("demandes", { responsable: text("responsable") }, (t) => [check("r_longueur", sql`char_length(${t.responsable}) <= 200`)]);
    expect(textesSansLimite([borne200])).toEqual([]);
    const motif = pgTable("alertes", { type: text("type") }, (t) => [check("t_code", sql`${t.type} ~ '^[a-z][a-z0-9_.-]{0,63}$'`)]);
    expect(textesSansLimite([motif])).toEqual([]);
    const trop = pgTable("demandes", { responsable: text("responsable") }, (t) => [check("r_longueur", sql`char_length(${t.responsable}) <= 5000`)]);
    expect(textesSansLimite([trop])).toEqual(["demandes.responsable : 5000 > 200"]);
  });

  it("[C-034] une colonne de la dette qui devient bornée doit en sortir ; une colonne neuve hors liste n'entre jamais dans la dette", () => {
    const bornee = pgTable("executions", { auteur: text("auteur") }, (t) => [check("a_longueur", sql`char_length(${t.auteur}) <= 200`)]);
    expect(textesSansLimite([bornee], undefined, ["executions.auteur"])).toEqual(["executions.auteur : désormais bornée, la retirer de la dette"]);
    const neuve = pgTable("demandes", { note: text("note") });
    expect(textesSansLimite([neuve])).toEqual(["demandes.note : hors de la liste fermée"]);
  });

  it("[C-034] la liste des textes permis est fermée : dix-sept colonnes bornées et aucune dette, sur demandes, executions, alertes, aujourdhui_ignores et les trois tables de conformité", () => {
    expect(Object.keys(TEXTE_PERMIS)).toHaveLength(17);
    expect(TEXTE_SANS_LIMITE_DETTE).toHaveLength(0);
    expect(Object.keys(TEXTE_PERMIS).every((k) => ["demandes", "executions", "alertes", "aujourdhui_ignores", "demandes_droits", "incidents_violations", "aipd"].includes(k.split(".")[0] ?? ""))).toBe(true);
    expect(Object.values(TEXTE_PERMIS).every((n) => n > 0 && n <= 256)).toBe(true);
  });
});

describe("dette des textes sans limite soldée (migration 0019)", () => {
  it("[T2-07] TEXTE_SANS_LIMITE_DETTE est vide", () => {
    expect(TEXTE_SANS_LIMITE_DETTE).toEqual([]);
  });
});

// Migration 0020 (T3-05a, ADR 0115) : tables de l'équipe, des vues et de « Aujourd'hui » ; colonnes de demandes et de notes.
describe("tables du lot 3 : équipe, vues, « Aujourd'hui » (T3-05a)", () => {
  const dossier = new URL("../../drizzle/", import.meta.url);
  const nomMigration = () => readdirSync(dossier).find((f) => f.startsWith("0020_") && f.endsWith(".sql")) ?? "0020_absente.sql";
  const COMMUNES_5A = ["public.membres_equipe", "public.absences", "public.vues_enregistrees"];

  it("[A-119] TABLES_CLIENT contient aujourdhui_ignores et TABLES_COMMUNES les trois tables communes de l'équipe", () => {
    expect(tablesDuSchema().length).toBeGreaterThan(10);
    expect(TABLES_CLIENT.map((t) => t.nom)).toContain("aujourdhui_ignores");
    for (const t of COMMUNES_5A) expect(TABLES_COMMUNES, t).toContain(t);
    for (const nom of ["membres_equipe", "absences", "vues_enregistrees"]) {
      expect(getTableConfig(tableNommee(nom)).columns.map((c) => c.name), nom).not.toContain("tenant_id");
    }
  });

  it("[LOT3-tables] aujourdhui_ignores : chaque colonne de texte est bornée", () => {
    expect(textesSansLimite([tableNommee("aujourdhui_ignores")])).toEqual([]);
  });

  it("[LOT3-tables] garde-migrations : migration additive seulement", () => {
    const nom = nomMigration();
    expect(nom).toBe("0020_tables_lot_3_equipe.sql");
    const texte = readFileSync(new URL(nom, dossier), "utf8");
    expect(analyserSql(nom, texte)).toEqual([]);
    const code = texte.replace(/--[^\n]*/g, "");
    expect(code).not.toMatch(/\b(DROP|TRUNCATE|RENAME)\b|\bDELETE\s+FROM\b/i);
    expect(code).not.toMatch(/ALTER\s+(TABLE\s+\S+\s+ALTER\s+COLUMN|COLUMN)[^;]*\bTYPE\b/i);
    expect(code).not.toMatch(/GRANT[^;]*\bDELETE\b|GRANT[^;]*\bTRUNCATE\b/i);
  });
});

// Migration 0021 (T3-05b, ADR 0115) : conformité, sous-traitants, signatures, historique des grilles.
describe("tables du lot 3 : conformité (T3-05b)", () => {
  const dossier = new URL("../../drizzle/", import.meta.url);
  const nomMigration = () => readdirSync(dossier).find((f) => f.startsWith("0021_") && f.endsWith(".sql")) ?? "0021_absente.sql";
  const CLIENT_5B = ["registre_client", "demandes_droits", "incidents_violations", "aipd"];
  const COMMUNES_5B = ["sous_traitants_ulterieurs", "signatures_fiches", "historique_grilles_prix"];

  it("[A-119] TABLES_CLIENT contient les quatre tables de conformité par client et TABLES_COMMUNES les six tables communes du lot 3", () => {
    expect(tablesDuSchema().length).toBeGreaterThan(10);
    for (const nom of CLIENT_5B) expect(TABLES_CLIENT.map((t) => t.nom), nom).toContain(nom);
    for (const nom of [...COMMUNES_5B, "membres_equipe", "absences", "vues_enregistrees"]) expect(TABLES_COMMUNES, nom).toContain(`public.${nom}`);
    for (const nom of COMMUNES_5B) expect(getTableConfig(tableNommee(nom)).columns.map((c) => c.name), nom).not.toContain("tenant_id");
  });

  it("[C-034] aucune colonne de texte libre dans demandes_droits, incidents_violations, aipd", () => {
    expect(textesSansLimite(["demandes_droits", "incidents_violations", "aipd"].map(tableNommee))).toEqual([]);
  });

  it("[LOT3-tables] garde-migrations : migration additive seulement", () => {
    const nom = nomMigration();
    expect(nom).toBe("0021_tables_lot_3_conformite.sql");
    const texte = readFileSync(new URL(nom, dossier), "utf8");
    expect(analyserSql(nom, texte)).toEqual([]);
    const code = texte.replace(/--[^\n]*/g, "");
    expect(code).not.toMatch(/\b(DROP|TRUNCATE|RENAME)\b|\bDELETE\s+FROM\b/i);
    expect(code).not.toMatch(/ALTER\s+(TABLE\s+\S+\s+ALTER\s+COLUMN|COLUMN)[^;]*\bTYPE\b/i);
    expect(code).not.toMatch(/GRANT[^;]*\bDELETE\b|GRANT[^;]*\bTRUNCATE\b/i);
    expect(code).not.toMatch(/\bCREATE\s+(OR\s+REPLACE\s+)?FUNCTION\b/i);
  });

  it("[LOT3-tables] les tables communes de conformité n'accordent aucun UPDATE ni droit à console_app, et chaque table a RLS activée et forcée", () => {
    const texte = readFileSync(new URL(nomMigration(), dossier), "utf8");
    for (const nom of [...CLIENT_5B, ...COMMUNES_5B]) {
      expect(texte, nom).toContain(`ALTER TABLE "public"."${nom}" ENABLE ROW LEVEL SECURITY`);
      expect(texte, nom).toContain(`ALTER TABLE "public"."${nom}" FORCE ROW LEVEL SECURITY`);
      expect(texte, nom).toContain(`REVOKE ALL ON TABLE "public"."${nom}" FROM PUBLIC`);
    }
    for (const nom of COMMUNES_5B) {
      expect(texte, nom).not.toMatch(new RegExp(`GRANT[^;]*ON TABLE "public"\\."${nom}" TO console_app`));
      expect(texte, nom).not.toMatch(new RegExp(`GRANT UPDATE[^;]*ON TABLE "public"\\."${nom}"`));
    }
  });
});

// Migration 0022 (T5-01a, ADR 0116) : tables de la supervision par client (lot 5).
// Liste fermée propre à ces tables (TEXTE_PERMIS, à compte exact, reste inchangée) : chaque ajout se relit en 2 tours (zone sécurité).
const TEXTE_SUPERVISION: Readonly<Record<string, number>> = Object.freeze({
  "liens_retour.adresse": 800,
  "suspensions_abus.posee_par": 200,
  "suspensions_abus.levee_par": 200,
  "rapports_mensuels.objet_pdf_ref": 255,
  "rapports_mensuels.envoye_par": 200,
  "mesures_bases.base": 60,
  "mesures_bases.version_structure": 32,
});
describe("tables du lot 5 : supervision par client (T5-01a)", () => {
  const dossier = new URL("../../drizzle/", import.meta.url);
  const nomMigration = () => readdirSync(dossier).find((f) => f.startsWith("0022_") && f.endsWith(".sql")) ?? "0022_absente.sql";
  const CLIENT_5A = ["sante_instances", "liens_retour", "suspensions_abus", "rapports_mensuels", "mesures_bases"];

  it("[A-119] TABLES_CLIENT contient les cinq tables de la supervision par client, aucune n'est dans TABLES_COMMUNES", () => {
    expect(tablesDuSchema().length).toBeGreaterThan(10);
    for (const nom of CLIENT_5A) {
      expect(TABLES_CLIENT.map((t) => t.nom), nom).toContain(nom);
      expect(TABLES_COMMUNES, nom).not.toContain(`public.${nom}`);
      expect(getTableConfig(tableNommee(nom)).columns.map((c) => c.name), nom).toContain("tenant_id");
    }
  });

  it("[LOT5-tables] garde des colonnes : aucune colonne de texte sans limite, aucune colonne de secret", () => {
    const tables = CLIENT_5A.map(tableNommee);
    expect(textesSansLimite(tables, TEXTE_SUPERVISION)).toEqual([]);
    expect(colonnesInterdites(tables)).toEqual([]);
    expect(Object.keys(TEXTE_SUPERVISION)).toHaveLength(7);
    // Une colonne de texte neuve hors liste est refusée.
    const neuve = pgTable("liens_retour", { note: text("note") });
    expect(textesSansLimite([neuve], TEXTE_SUPERVISION)).toEqual(["liens_retour.note : hors de la liste fermée"]);
  });

  it("[LOT5-tables] garde-migrations : migration 0022 additive seulement, avec l'unique fonction de protection des partitions", () => {
    const nom = nomMigration();
    expect(nom).toBe("0022_supervision_clients.sql");
    const texte = readFileSync(new URL(nom, dossier), "utf8");
    expect(analyserSql(nom, texte)).toEqual([]);
    const code = texte.replace(/--[^\n]*/g, "");
    expect(code).not.toMatch(/\b(DROP|TRUNCATE|RENAME)\b|\bDELETE\s+FROM\b/i);
    expect(code).not.toMatch(/ALTER\s+(TABLE\s+\S+\s+ALTER\s+COLUMN|COLUMN)[^;]*\bTYPE\b/i);
    expect(code).not.toMatch(/GRANT[^;]*\bDELETE\b|GRANT[^;]*\bTRUNCATE\b/i);
    expect([...code.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(\S+)/gi)].map((m) => m[1])).toEqual(["public.mesures_bases_proteger_partitions()"]);
    expect(code).not.toMatch(/SECURITY\s+DEFINER/i);
  });

  it("[LOT5-tables] chaque table de la 0022 a RLS activée et forcée, PUBLIC sans droit, et console_lecture en lecture seule sous sa politique", () => {
    const texte = readFileSync(new URL(nomMigration(), dossier), "utf8");
    for (const nom of CLIENT_5A) {
      expect(texte, nom).toContain(`ALTER TABLE "public"."${nom}" ENABLE ROW LEVEL SECURITY`);
      expect(texte, nom).toContain(`ALTER TABLE "public"."${nom}" FORCE ROW LEVEL SECURITY`);
      expect(texte, nom).toContain(`REVOKE ALL ON TABLE "public"."${nom}" FROM PUBLIC`);
    }
    for (const nom of [...CLIENT_5A, "alertes", "agregats_quotidiens"]) {
      expect(texte, nom).toContain(`CREATE POLICY isolation_lecture ON "public"."${nom}" FOR SELECT TO console_lecture`);
      expect(texte, nom).toContain(`GRANT SELECT ON TABLE "public"."${nom}" TO console_lecture`);
    }
    expect(texte).not.toMatch(/GRANT[^;]*(INSERT|UPDATE)[^;]*TO console_lecture/);
    // mesures_bases : aucun droit pour console_app (écrite par la tâche de relevé, sous console_equipe).
    expect(texte).not.toMatch(/GRANT[^;]*ON TABLE "public"\."mesures_bases" TO console_app/);
    expect(texte).toMatch(/partman\.create_parent\(\s*p_parent_table => 'public\.mesures_bases',\s*p_control => 'debut',\s*p_interval => '1 month',\s*p_premake => 4/);
    expect(texte).toContain('PARTITION BY RANGE ("debut")');
  });
});
