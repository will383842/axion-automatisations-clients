import { readdirSync, readFileSync } from "node:fs";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { analyserSql } from "../../../../../scripts/garde-migrations.ts";
import { instances } from "./clients.ts";

// Migration 0026 (T4-54a) : instances.mode_ia, ajout seul. Les essais contre PostgreSQL sont dans db/mode-ia.int.test.ts.
const dossier = new URL("../../../drizzle/", import.meta.url);
const NOM = "0026_mode_ia_instance.sql";
const migration = () => readFileSync(new URL(NOM, dossier), "utf8");
const code = () => migration().replace(/--[^\n]*/g, "");
const lire = (f: string) => JSON.parse(readFileSync(new URL(f, dossier), "utf8")) as Record<string, unknown>;

describe("instances.mode_ia : schéma et migration 0026", () => {
  it("[C-634] mode_ia est une colonne de instances, non nulle, via_axion par défaut, bornée à deux modes", () => {
    const c = getTableConfig(instances).columns.find((x) => x.name === "mode_ia");
    expect(c?.notNull).toBe(true);
    expect(c?.default).toBe("via_axion");
    const texte = code();
    expect(texte).toMatch(/ALTER TABLE "instances" ADD COLUMN "mode_ia" text DEFAULT 'via_axion' NOT NULL/);
    expect(texte).toMatch(/"instances_mode_ia_borne" CHECK \("instances"\."mode_ia" IN \('client_direct', 'via_axion'\)\)/);
  });

  it("[C-634] droits par colonne : console_app reçoit SELECT, INSERT et UPDATE sur mode_ia seulement, jamais de droit de table", () => {
    const texte = code();
    for (const d of ["SELECT", "INSERT", "UPDATE"]) expect(texte).toContain(`GRANT ${d} ("mode_ia") ON TABLE "public"."instances" TO console_app;`);
    expect(texte).not.toMatch(/GRANT[^;]*ON TABLE "public"\."instances"[^;]*TO (PUBLIC|console_lecture|console_equipe)/);
    expect(texte).not.toMatch(/GRANT (SELECT|INSERT|UPDATE|ALL)[^(;]*ON TABLE "public"\."instances"/);
    expect(texte).not.toMatch(/DISABLE ROW LEVEL SECURITY|NO FORCE|DROP POLICY|CREATE POLICY|CREATE TRIGGER/i);
  });

  it("[C-634] garde-migrations : 0026 additive seulement, sans fonction", () => {
    expect(analyserSql(NOM, migration())).toEqual([]);
    const t = code();
    expect(t).not.toMatch(/\b(DROP|TRUNCATE|RENAME)\b|\bDELETE\s+FROM\b/i);
    expect(t).not.toMatch(/ALTER\s+COLUMN[^;]*\bTYPE\b/i);
    expect(t).not.toMatch(/GRANT[^;]*\b(DELETE|TRUNCATE)\b/i);
    expect(t).not.toMatch(/\bCREATE\s+(OR\s+REPLACE\s+)?FUNCTION\b|SECURITY\s+DEFINER|^\s*DO\b/im);
  });

  it("[C-634] journal et instantané : 0026 suit 0025, quand croît, prevId de 0026 = id de 0025, un seul fichier 0026", () => {
    const journal = (lire("meta/_journal.json") as { entries: { idx: number; tag: string; when: number }[] }).entries;
    const i = journal.findIndex((e) => e.tag === "0026_mode_ia_instance");
    expect(i).toBeGreaterThan(0);
    expect(journal[i - 1]?.tag).toBe("0025_portail");
    expect(journal[i]?.idx).toBe((journal[i - 1]?.idx ?? 0) + 1);
    expect(journal[i]?.when ?? 0).toBeGreaterThan(journal[i - 1]?.when ?? Infinity);
    expect(journal.length).toBeGreaterThanOrEqual(i + 1);
    expect(lire("meta/0026_snapshot.json")["prevId"]).toBe(lire("meta/0025_snapshot.json")["id"]);
    expect(readdirSync(dossier).filter((f) => /^0026_.*\.sql$/.test(f))).toEqual([NOM]);
  });
});
