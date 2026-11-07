import { readdirSync, readFileSync } from "node:fs";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { analyserSql } from "../../../../../scripts/garde-migrations.ts";
import { finsDeContrat } from "./bases-client.ts";

// Une seule fin de contrat par client (T2-44b-a). Le fichier est trouvé par son sujet, jamais par son numéro : il survit à une renumérotation.
// Les essais contre PostgreSQL sont à la fin de db/bases-client.int.test.ts (aucun nouveau fichier d'essai en base : partition du socle, ADR 0121).
const dossier = new URL("../../../drizzle/", import.meta.url);
const SUJET = "fin_de_contrat_une_par_client";
const fichier = () => readdirSync(dossier).find((f) => new RegExp(`^\\d{4}_${SUJET}\\.sql$`).test(f));
const lireSql = () => {
  const nom = fichier();
  if (!nom) throw new Error(`migration « ${SUJET} » introuvable`);
  return { nom, texte: readFileSync(new URL(nom, dossier), "utf8") };
};
const instructions = (texte: string) => texte.replace(/--[^\n]*/g, "").split(/-->\s*statement-breakpoint|;/).map((s) => s.trim()).filter((s) => s !== "");

describe("une fin de contrat par client : schéma et migration", () => {
  it("[C-035] la migration « fin_de_contrat_une_par_client » n'ajoute que UNIQUE (tenant_id) sur fins_de_contrat : analyserSql rend [] et le texte n'a ni DELETE, ni ALTER POLICY, ni ADD COLUMN, ni ADD VALUE, ni CREATE FUNCTION", () => {
    const { nom, texte } = lireSql();
    expect(analyserSql(nom, texte)).toEqual([]);
    const code = texte.replace(/--[^\n]*/g, "");
    for (const interdit of [/\bDELETE\b/i, /\bALTER\s+POLICY\b/i, /\bADD\s+COLUMN\b/i, /\bADD\s+VALUE\b/i, /\bCREATE\s+FUNCTION\b/i, /\bDROP\b/i, /\bTRUNCATE\b/i, /\bRENAME\b/i]) expect(code).not.toMatch(interdit);
    const liste = instructions(texte);
    expect(liste).toHaveLength(1);
    expect(liste[0]).toMatch(/^ALTER TABLE "fins_de_contrat" ADD CONSTRAINT "fins_de_contrat_une_par_client" UNIQUE\s*\(\s*"tenant_id"\s*\)$/);
  });

  it("[C-035] le schéma Drizzle porte l'unicité [\"tenant_id\"] nommée fins_de_contrat_une_par_client et garde l'index fins_de_contrat_tenant_id_idx", () => {
    const config = getTableConfig(finsDeContrat);
    const une = config.uniqueConstraints.find((u) => u.name === "fins_de_contrat_une_par_client");
    expect(une?.columns.map((c) => c.name)).toEqual(["tenant_id"]);
    expect(config.indexes.map((i) => i.config.name)).toContain("fins_de_contrat_tenant_id_idx");
  });

  it("[C-035] le journal range le tag fin_de_contrat_une_par_client juste après file_d_alertes, avec un when strictement croissant", () => {
    const journal = JSON.parse(readFileSync(new URL("meta/_journal.json", dossier), "utf8")) as { entries: { idx: number; tag: string; when: number }[] };
    const sujets = journal.entries.map((e) => e.tag.replace(/^\d{4}_/, ""));
    const i = sujets.indexOf(SUJET);
    expect(i).toBeGreaterThan(0);
    expect(sujets[i - 1]).toBe("file_d_alertes");
    expect(journal.entries[i]?.tag).toBe(lireSql().nom.replace(/\.sql$/, ""));
    for (let k = 1; k < journal.entries.length; k++) expect(journal.entries[k]!.when, journal.entries[k]!.tag).toBeGreaterThan(journal.entries[k - 1]!.when);
  });
});
