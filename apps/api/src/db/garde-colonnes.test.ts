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
  // T5-01b (migration 0023) : colonnes d'alertes, bornées par un motif (clé de regroupement 128, cause 64).
  "alertes.cle_regroupement": 128,
  "alertes.cause": 64,
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

  it("[C-034] la liste des textes permis est fermée : dix-neuf colonnes bornées et aucune dette, sur demandes, executions, alertes, aujourdhui_ignores et les trois tables de conformité", () => {
    expect(Object.keys(TEXTE_PERMIS)).toHaveLength(19);
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

// Migration 0023 (T5-01b, ADR 0116) : tables communes de la supervision, deux tables par client, mesures_capacite (non partitionnée, ESCALADE C5), quatre colonnes d'alertes.
const COMMUNES_5B = ["incidents", "regles_alertes", "disjoncteurs", "reveils", "mesures_capacite", "modeles_messages", "bilans_incident", "fenetres_maintenance", "avis_depreciation"];
const CLIENT_5B = ["incidents_instances", "commentaires_alertes"];
// Liste fermée propre à la 0023 (TEXTE_PERMIS reçoit seulement les deux colonnes d'alertes) : chaque ajout se relit en 2 tours (zone sécurité).
const TEXTE_SUPERVISION_5B: Readonly<Record<string, number>> = Object.freeze({
  "incidents.cause": 64,
  "regles_alertes.code": 64,
  "disjoncteurs.motif_code": 64,
  "disjoncteurs.pose_par": 200,
  "disjoncteurs.leve_par": 200,
  "reveils.cause": 64,
  "reveils.justification": 500,
  "reveils.auteur": 200,
  "mesures_capacite.cible_code": 64,
  "modeles_messages.cle": 64,
  "modeles_messages.texte": 4000,
  "modeles_messages.cree_par": 200,
  "bilans_incident.reference_document": 255,
  "bilans_incident.redige_par": 200,
  "fenetres_maintenance.cible_code": 64,
  "fenetres_maintenance.auteur": 200,
  "avis_depreciation.fournisseur": 64,
  "avis_depreciation.sujet": 64,
  "commentaires_alertes.auteur": 200,
  "commentaires_alertes.texte": 500,
});
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

describe("tables du lot 5 : supervision commune (T5-01b)", () => {
  const dossier = new URL("../../drizzle/", import.meta.url);
  const nomMigration = () => readdirSync(dossier).find((f) => f.startsWith("0023_") && f.endsWith(".sql")) ?? "0023_absente.sql";
  const texte0023 = () => readFileSync(new URL(nomMigration(), dossier), "utf8");

  it("[LOT5-tables] les 9 tables communes sont dans TABLES_COMMUNES et seulement elles", () => {
    expect(tablesDuSchema().length).toBeGreaterThan(10);
    for (const nom of COMMUNES_5B) {
      expect(TABLES_COMMUNES, nom).toContain(`public.${nom}`);
      expect(getTableConfig(tableNommee(nom)).columns.map((c) => c.name), nom).not.toContain("tenant_id");
    }
    for (const nom of CLIENT_5B) {
      expect(TABLES_COMMUNES, nom).not.toContain(`public.${nom}`);
      expect(TABLES_CLIENT.map((t) => t.nom), nom).toContain(nom);
      expect(getTableConfig(tableNommee(nom)).columns.map((c) => c.name), nom).toContain("tenant_id");
    }
    // Les neuf, et aucune autre table de la supervision, entrent dans la liste fermée (elle compte 9 de plus qu'avant la 0023).
    expect(TABLES_COMMUNES.filter((t) => COMMUNES_5B.includes(t.replace("public.", "")))).toHaveLength(9);
    expect(TABLES_COMMUNES).toHaveLength(32);
    expect(Object.isFrozen(TABLES_COMMUNES)).toBe(true);
  });

  it("[LOT5-tables] garde des colonnes 0023 : aucune colonne de texte sans limite, aucune colonne de secret, alertes comprise", () => {
    const tables = [...COMMUNES_5B, ...CLIENT_5B].map(tableNommee);
    expect(textesSansLimite(tables, TEXTE_SUPERVISION_5B)).toEqual([]);
    expect(colonnesInterdites(tables)).toEqual([]);
    expect(Object.keys(TEXTE_SUPERVISION_5B)).toHaveLength(20);
    expect(textesSansLimite(["alertes"].map(tableNommee))).toEqual([]);
    expect(TEXTE_PERMIS["alertes.cle_regroupement"]).toBe(128);
    expect(TEXTE_PERMIS["alertes.cause"]).toBe(64);
    expect(Object.keys(TEXTE_PERMIS)).toHaveLength(19);
    const neuve = pgTable("incidents", { note: text("note") });
    expect(textesSansLimite([neuve], TEXTE_SUPERVISION_5B)).toEqual(["incidents.note : hors de la liste fermée"]);
  });

  it("[LOT5-tables] garde des colonnes : chaque colonne text[] est bornée en nombre et en forme", () => {
    expect(tableauxSansBorne(tablesDuSchema())).toEqual([]);
    const libre = pgTable("liens_retour", { elements: text("elements").array() });
    expect(tableauxSansBorne([libre])).toEqual(["liens_retour.elements : nombre d'éléments non borné", "liens_retour.elements : forme des éléments non bornée"]);
    const nombreSeul = pgTable("liens_retour", { elements: text("elements").array() }, (t) => [check("e_nombre", sql`cardinality(${t.elements}) <= 8`)]);
    expect(tableauxSansBorne([nombreSeul])).toEqual(["liens_retour.elements : forme des éléments non bornée"]);
    // La migration 0023 pose la borne de forme de liens_retour.attributs_trouves en ajout seul (NOT VALID).
    expect(texte0023()).toMatch(/ADD CONSTRAINT "liens_retour_attributs_codes" CHECK[^;]*NOT VALID/);
  });

  it("[LOT5-tables] garde-migrations : migration 0023 additive seulement, sans fonction ni partition (mesures_capacite reste non partitionnée, ESCALADE C5)", () => {
    const nom = nomMigration();
    expect(nom).toBe("0023_supervision_communes.sql");
    const texte = texte0023();
    expect(analyserSql(nom, texte)).toEqual([]);
    const code = texte.replace(/--[^\n]*/g, "");
    expect(code).not.toMatch(/\b(DROP|TRUNCATE|RENAME)\b|\bDELETE\s+FROM\b/i);
    expect(code).not.toMatch(/ALTER\s+(TABLE\s+\S+\s+ALTER\s+COLUMN|COLUMN)[^;]*\bTYPE\b/i);
    expect(code).not.toMatch(/GRANT[^;]*\bDELETE\b|GRANT[^;]*\bTRUNCATE\b/i);
    expect([...code.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(\S+)/gi)].map((m) => m[1])).toEqual([]);
    expect(code).not.toMatch(/PARTITION\s+BY|partman\./i);
    expect(code).not.toMatch(/SECURITY\s+DEFINER/i);
    expect(code).not.toMatch(/^\s*DO\b|\bCONCURRENTLY\b/im);
  });

  it("[LOT5-tables] chaque table de la 0023 a RLS activée et forcée, PUBLIC sans droit ; disjoncteurs et reveils sans aucun droit pour console_app", () => {
    const texte = texte0023();
    for (const nom of [...COMMUNES_5B, ...CLIENT_5B]) {
      expect(texte, nom).toContain(`ALTER TABLE "public"."${nom}" ENABLE ROW LEVEL SECURITY`);
      expect(texte, nom).toContain(`ALTER TABLE "public"."${nom}" FORCE ROW LEVEL SECURITY`);
      expect(texte, nom).toContain(`REVOKE ALL ON TABLE "public"."${nom}" FROM PUBLIC`);
      expect(texte, nom).toContain(`FOR EACH ROW EXECUTE FUNCTION public.audit_ecrire`);
    }
    for (const nom of ["disjoncteurs", "reveils"]) {
      expect(texte, nom).not.toMatch(new RegExp(`GRANT[^;]*ON TABLE "public"\\."${nom}" TO console_app`));
      expect(texte, nom).not.toMatch(new RegExp(`CREATE POLICY \\w+ ON "public"\\."${nom}"[^;]*TO console_app`));
    }
    // Ajout seul : aucun UPDATE sur ces tables.
    for (const nom of ["reveils", "modeles_messages", "bilans_incident", "commentaires_alertes"]) {
      expect(texte, nom).not.toMatch(new RegExp(`GRANT UPDATE[^;]*ON TABLE "public"\\."${nom}"`));
    }
    // console_lecture : SELECT seul, et seulement sur les deux tables par client de la 0023.
    expect(texte).not.toMatch(/GRANT[^;]*(INSERT|UPDATE)[^;]*TO console_lecture/);
    expect([...texte.matchAll(/GRANT SELECT ON TABLE "public"\."(\w+)" TO console_lecture/g)].map((m) => m[1]).sort()).toEqual(["commentaires_alertes", "incidents_instances"]);
    for (const nom of CLIENT_5B) expect(texte, nom).toContain(`CREATE POLICY isolation_lecture ON "public"."${nom}" FOR SELECT TO console_lecture`);
  });

  it("[LOT5-tables] alertes reçoit quatre colonnes en ajout seul, sans toucher aux contraintes existantes", () => {
    const code = texte0023().replace(/--[^\n]*/g, "");
    for (const c of ["cle_regroupement", "cause", "incident_id", "derniere_relance"]) expect(code, c).toContain(`ALTER TABLE "alertes" ADD COLUMN "${c}"`);
    expect(code).toContain('GRANT UPDATE ("cle_regroupement", "cause", "incident_id", "derniere_relance") ON TABLE "public"."alertes" TO console_app');
    expect(code).not.toContain("alertes_assignee_borne");
    expect(getTableConfig(tableNommee("alertes")).columns.map((c) => c.name)).toEqual(expect.arrayContaining(["cle_regroupement", "cause", "incident_id", "derniere_relance"]));
  });

  it("[LOT5-tables] journal et instantané : le tag 0023 suit 0022, quand croît, prevId de 0023 = id de 0022", () => {
    const lire = (f: string) => JSON.parse(readFileSync(new URL(f, dossier), "utf8")) as Record<string, unknown>;
    const journal = (lire("meta/_journal.json") as { entries: { idx: number; tag: string; when: number }[] }).entries;
    // Position de la 0023 cherchée par son tag : une migration suivante (0024, T4-34a) peut la suivre.
    const i = journal.findIndex((e) => e.tag === "0023_supervision_communes");
    const dernier = journal[i];
    const avant = journal[i - 1];
    expect(dernier?.tag).toBe("0023_supervision_communes");
    expect(avant?.tag).toBe("0022_supervision_clients");
    expect(dernier?.idx).toBe((avant?.idx ?? 0) + 1);
    expect(dernier?.when ?? 0).toBeGreaterThan(avant?.when ?? Infinity);
    expect(lire("meta/0023_snapshot.json")["prevId"]).toBe(lire("meta/0022_snapshot.json")["id"]);
    expect(readdirSync(dossier).filter((f) => /^00(18|19)_.*(supervision|communes)/.test(f))).toEqual([]);
  });

  it("[LOT5-tables] l'ADR 0116 documente le retour arrière de la 0023 et la dette d'appel de la protection des partitions", () => {
    const adr = readFileSync(new URL("../../../../docs/adr/0116-tables-de-la-supervision.md", import.meta.url), "utf8");
    expect(adr).toContain("0023_supervision_communes.sql");
    expect(adr).toMatch(/Retour arrière de la 0023/);
    expect(adr).toMatch(/mesures_bases_proteger_partitions/);
    expect(adr).toMatch(/partman\.run_maintenance/);
    expect(adr).toMatch(/ESCALADE[^\n]*mesures_capacite|mesures_capacite[^\n]*ESCALADE/);
    expect(adr).toMatch(/BYPASSRLS|créer le rôle/i);
  });

  it("[LOT5-tables] les dettes M1 à M5 et F1 à F6 de l'audit de la 0022 sont inscrites avec leur critère de test et leur fiche", () => {
    const preuves = readFileSync(new URL("../../../../spec/preuves/lot-5-t5-01b.md", import.meta.url), "utf8");
    for (const d of ["M1", "M2", "M5", "F1", "F2", "F3", "F4", "F6", "M4"]) expect(preuves, d).toMatch(new RegExp(`LOT5-dette-T5-01a-${d}\\b`));
    expect(preuves).toMatch(/M3[^\n]*soldée/);
    expect(preuves).toMatch(/F5[^\n]*soldée/);
    for (const ligne of preuves.split("\n").filter((l) => l.includes("LOT5-dette-"))) expect(ligne, ligne.slice(0, 40)).toMatch(/critère de test : « \[(A-188|LOT5-tables)\]/);
  });
});

// Migration 0024 (T4-34a, ADR 0117) : modèle d'IA par client et par instance, référence de la clé d'IA propre du client.
// Liste fermée propre à cette table (TEXTE_PERMIS, à compte exact, reste inchangée) : chaque ajout se relit en 2 tours (zone secrets).
const TEXTE_IA: Readonly<Record<string, number>> = Object.freeze({
  "cles_ia_client.fournisseur": 64,
  "cles_ia_client.reference_coffre": 96,
  "cles_ia_client.dernier_refus_code": 64,
  "cles_ia_client.cree_par": 200,
});
describe("tables du lot 4 : modèle d'IA et clé du client (T4-34a)", () => {
  const dossier = new URL("../../drizzle/", import.meta.url);
  const nomMigration = () => readdirSync(dossier).find((f) => f.startsWith("0024_") && f.endsWith(".sql")) ?? "0024_absente.sql";
  const texte0024 = () => readFileSync(new URL(nomMigration(), dossier), "utf8");

  it("[LOT4-ia] garde des colonnes : cles_ia_client n'a aucune colonne de texte sans limite ni colonne de secret", () => {
    expect(TABLES_CLIENT.map((t) => t.nom)).toContain("cles_ia_client");
    expect(TABLES_COMMUNES).not.toContain("public.cles_ia_client");
    expect(TABLES_COMMUNES).toHaveLength(32);
    const t = tableNommee("cles_ia_client");
    expect(textesSansLimite([t], TEXTE_IA)).toEqual([]);
    expect(colonnesInterdites([t])).toEqual([]);
    expect(getTableConfig(t).columns.map((c) => c.name)).toContain("tenant_id");
    expect(Object.keys(TEXTE_IA)).toHaveLength(4);
    // modele_ia (instances) et modele_ia_defaut (organisations) sont bornés par un motif ; TEXTE_PERMIS garde son compte exact.
    expect(Object.keys(TEXTE_PERMIS)).toHaveLength(19);
    const brute = pgTable("cles_ia_client", { valeur: text("valeur") });
    expect(textesSansLimite([brute], TEXTE_IA)).toEqual(["cles_ia_client.valeur : hors de la liste fermée"]);
    expect(colonnesInterdites([pgTable("cles_ia_client", { cle_api: text("cle_api") })])).toEqual(["cles_ia_client.cle_api"]);
  });

  it("[LOT4-ia] journal et instantané : le tag 0024 suit 0023, quand croît, prevId de 0024 = id de 0023", () => {
    const lire = (f: string) => JSON.parse(readFileSync(new URL(f, dossier), "utf8")) as Record<string, unknown>;
    const journal = (lire("meta/_journal.json") as { entries: { idx: number; tag: string; when: number }[] }).entries;
    const i = journal.findIndex((e) => e.tag === "0024_modele_ia_et_cle_client");
    expect(i).toBeGreaterThan(0);
    expect(journal[i - 1]?.tag).toBe("0023_supervision_communes");
    expect(journal[i]?.idx).toBe((journal[i - 1]?.idx ?? 0) + 1);
    expect(journal[i]?.when ?? 0).toBeGreaterThan(journal[i - 1]?.when ?? Infinity);
    expect(lire("meta/0024_snapshot.json")["prevId"]).toBe(lire("meta/0023_snapshot.json")["id"]);
    expect(readdirSync(dossier).filter((f) => /^0020_modele/.test(f))).toEqual([]);
  });

  it("[LOT4-ia] garde-migrations : migration 0024 additive seulement, sans fonction", () => {
    const nom = nomMigration();
    expect(nom).toBe("0024_modele_ia_et_cle_client.sql");
    const texte = texte0024();
    expect(analyserSql(nom, texte)).toEqual([]);
    const code = texte.replace(/--[^\n]*/g, "");
    expect(code).not.toMatch(/\b(DROP|TRUNCATE|RENAME)\b|\bDELETE\s+FROM\b/i);
    expect(code).not.toMatch(/ALTER\s+(TABLE\s+\S+\s+ALTER\s+COLUMN|COLUMN)[^;]*\bTYPE\b/i);
    expect(code).not.toMatch(/GRANT[^;]*\bDELETE\b|GRANT[^;]*\bTRUNCATE\b/i);
    expect(code).not.toMatch(/\bCREATE\s+(OR\s+REPLACE\s+)?FUNCTION\b|SECURITY\s+DEFINER/i);
    expect(code).not.toMatch(/^\s*DO\b|\bCONCURRENTLY\b/im);
  });

  it("[LOT4-ia] cles_ia_client : RLS activée et forcée, PUBLIC sans droit, aucun droit pour console_lecture, aucune écriture de la référence", () => {
    const texte = texte0024();
    expect(texte).toContain('ALTER TABLE "public"."cles_ia_client" ENABLE ROW LEVEL SECURITY');
    expect(texte).toContain('ALTER TABLE "public"."cles_ia_client" FORCE ROW LEVEL SECURITY');
    expect(texte).toContain('REVOKE ALL ON TABLE "public"."cles_ia_client" FROM PUBLIC');
    expect(texte).toContain("FOR EACH ROW EXECUTE FUNCTION public.audit_ecrire");
    expect(texte).not.toMatch(/GRANT[^;]*console_lecture/);
    expect(texte).not.toMatch(/GRANT UPDATE[^;]*"(reference_coffre|fournisseur|organisation_id|cree_par)"/);
    expect(texte).toMatch(/ALTER TABLE "organisations" VALIDATE CONSTRAINT "organisations_modele_ia_defaut_forme"/);
  });
});

// Migration 0027 (T4-27a, ADR 0122) : cycle de vie des versions et preuves de la procédure.
// Liste fermée propre à ces deux tables (TEXTE_PERMIS, à compte exact, reste inchangé) : chaque ajout se relit en 2 tours (zone données).
const TEXTE_CYCLE: Readonly<Record<string, number>> = Object.freeze({
  "passages_version.empreinte_sha256": 65,
  "passages_version.auteur": 200,
  "preuves_procedure.empreinte_sha256": 65,
  "preuves_procedure.reference": 255,
  "preuves_procedure.auteur": 200,
});
describe("tables du lot 4 : cycle de vie des versions (T4-27a)", () => {
  const dossier = new URL("../../drizzle/", import.meta.url);
  const texte0027 = () => readFileSync(new URL("0027_cycle_de_vie_des_versions.sql", dossier), "utf8");

  it("[LOT4-cycle] garde des colonnes 0027 : textes bornés, aucune colonne de secret, TABLES_COMMUNES compte 32", () => {
    const tables = ["passages_version", "preuves_procedure"].map(tableNommee);
    expect(TABLES_COMMUNES).toHaveLength(32);
    for (const nom of ["passages_version", "preuves_procedure"]) {
      expect(TABLES_COMMUNES, nom).toContain(`public.${nom}`);
      expect(getTableConfig(tableNommee(nom)).columns.map((c) => c.name), nom).not.toContain("tenant_id");
    }
    // L'empreinte est bornée par une longueur exacte ({64}$), que l'analyseur de bornes ne lit pas : elle est contrôlée à part, par son CHECK de forme.
    const empreintes = ["passages_version.empreinte_sha256", "preuves_procedure.empreinte_sha256"];
    expect(textesSansLimite(tables, TEXTE_CYCLE).filter((l) => !empreintes.some((e) => l.startsWith(`${e} : aucune longueur maximale`)))).toEqual([]);
    for (const t of tables) expect(getTableConfig(t).checks.map((c) => new PgDialect().sqlToQuery(c.value).sql).some((v) => v.includes('"empreinte_sha256" ~ \'^[0-9a-f]{64}$\''))).toBe(true);
    expect(colonnesInterdites(tables)).toEqual([]);
    expect(Object.keys(TEXTE_CYCLE)).toHaveLength(5);
    expect(Object.keys(TEXTE_PERMIS)).toHaveLength(19);
    // La colonne text[] ajoutée à versions_automatisation est bornée en nombre et en forme.
    expect(tableauxSansBorne([tableNommee("versions_automatisation")])).toEqual([]);
    expect(getTableConfig(tableNommee("versions_automatisation")).columns.map((c) => c.name)).toContain("modeles_testes");
  });

  it("[LOT4-cycle] garde-migrations : migration 0027 additive seulement, sans fonction ni valeur d'énumération", () => {
    const texte = texte0027();
    expect(analyserSql("0027_cycle_de_vie_des_versions.sql", texte)).toEqual([]);
    const code = texte.replace(/--[^\n]*/g, "");
    expect(code).not.toMatch(/\b(DROP|TRUNCATE|RENAME)\b|\bDELETE\s+FROM\b/i);
    expect(code).not.toMatch(/\bALTER\s+TYPE\b|ALTER\s+COLUMN[^;]*\bTYPE\b|ADD\s+VALUE/i);
    expect(code).not.toMatch(/\bCREATE\s+(OR\s+REPLACE\s+)?FUNCTION\b|SECURITY\s+DEFINER|^\s*DO\b|\bCONCURRENTLY\b/im);
    expect(code).not.toMatch(/GRANT[^;]*\b(DELETE|TRUNCATE)\b/i);
  });
});

// Migration 0028 (T4-28a, ADR 0125) : tests à blanc et journal des déploiements. Liste fermée propre à ces tables (TEXTE_PERMIS reste à 19) : chaque ajout se relit en 2 tours (zone sécurité).
const TEXTE_DEPLOIEMENT: Readonly<Record<string, number>> = Object.freeze({
  // Motif ^[a-z0-9_.-]{1,64}$ (64 caractères au plus) : la mesure de la garde compte « n + 1 » pour un motif {m,n}$ (convention du premier caractère), d'où 65.
  "tests_a_blanc.code_erreur": 65,
  "tests_a_blanc.auteur": 200,
  "deploiements_instance.cause": 65,
  "deploiements_instance.auteur": 200,
});
describe("tables du lot 4 : déploiement (T4-28a)", () => {
  it("[LOT4-deploiement] garde des colonnes 0028 : textes bornés (TEXTE_DEPLOIEMENT compte 4), aucune colonne de secret, TABLES_COMMUNES compte toujours 32", () => {
    const tables = ["tests_a_blanc", "deploiements_instance"].map(tableNommee);
    expect(TABLES_CLIENT.map((t) => t.nom)).toEqual(expect.arrayContaining(["tests_a_blanc", "deploiements_instance"]));
    expect(TABLES_COMMUNES).not.toContain("public.tests_a_blanc");
    expect(TABLES_COMMUNES).not.toContain("public.deploiements_instance");
    expect(TABLES_COMMUNES).toHaveLength(32);
    expect(Object.keys(TEXTE_DEPLOIEMENT)).toHaveLength(4);
    expect(textesSansLimite(tables, TEXTE_DEPLOIEMENT)).toEqual([]);
    expect(colonnesInterdites(tables)).toEqual([]);
    expect(Object.keys(TEXTE_PERMIS)).toHaveLength(19);
    const brute = pgTable("tests_a_blanc", { rapport: text("rapport") });
    expect(textesSansLimite([brute], TEXTE_DEPLOIEMENT)).toEqual(["tests_a_blanc.rapport : hors de la liste fermée"]);
  });
});
