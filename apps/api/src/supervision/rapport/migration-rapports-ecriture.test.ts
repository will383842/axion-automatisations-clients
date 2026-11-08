import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { analyserSql } from "../../../../../scripts/garde-migrations.ts";

// T5-22a (ADR 0141) : ouverture de l'écriture de rapports_mensuels à console_app, DROITS SEULEMENT.
// Le fichier est trouvé par son sujet, jamais par son numéro : il survit à une renumérotation.
// Les essais contre PostgreSQL sont dans droits-rapports.int.test.ts (CI socle-integration, aucun Docker ici).
const dossier = new URL("../../../drizzle/", import.meta.url);
const SUJET = "rapports_mensuels_ecriture";
const fichier = () => readdirSync(dossier).find((f) => new RegExp(`^\\d{4}_${SUJET}\\.sql$`).test(f));
const lire = () => {
  const nom = fichier();
  if (!nom) throw new Error(`migration « ${SUJET} » introuvable`);
  return { nom, texte: readFileSync(new URL(nom, dossier), "utf8") };
};
const code = () => lire().texte.replace(/--[^\n]*/g, "");
const instructions = () => code().split(/-->\s*statement-breakpoint/).map((s) => s.trim().replace(/;$/, "")).filter((s) => s !== "");

describe("écriture des rapports mensuels : migration de droits", () => {
  it("[B-406] la migration « rapports_mensuels_ecriture » passe la garde des migrations et n'ajoute que des droits et deux politiques restrictives", () => {
    const { nom, texte } = lire();
    expect(analyserSql(nom, texte)).toEqual([]);
    for (const interdit of [/\bDELETE\b/i, /\bTRUNCATE\b/i, /\bDROP\b/i, /\bRENAME\b/i, /\bALTER\s+(POLICY|TABLE|TYPE)\b/i, /\bADD\s+(COLUMN|VALUE)\b/i, /\bCREATE\s+(FUNCTION|TABLE|TRIGGER)\b/i]) {
      expect(code()).not.toMatch(interdit);
    }
    expect(instructions().map((s) => s.split(/\s+/).slice(0, 2).join(" ")).sort()).toEqual(["CREATE POLICY", "CREATE POLICY", "GRANT INSERT", "GRANT UPDATE"]);
  });

  it("[B-406] INSERT n'est accordé à console_app que sur les cinq colonnes de préparation (jamais etat, envoye_par ni envoye_le)", () => {
    const g = instructions().find((s) => s.startsWith("GRANT INSERT")) ?? "";
    expect(g).toBe('GRANT INSERT ("tenant_id", "id", "organisation_id", "mois", "objet_pdf_ref") ON TABLE "public"."rapports_mensuels" TO console_app');
  });

  it("[B-407] UPDATE n'est accordé à console_app que sur les trois colonnes d'envoi (jamais objet_pdf_ref, mois ni organisation_id)", () => {
    const g = instructions().find((s) => s.startsWith("GRANT UPDATE")) ?? "";
    expect(g).toBe('GRANT UPDATE ("etat", "envoye_par", "envoye_le") ON TABLE "public"."rapports_mensuels" TO console_app');
  });

  it("[B-406] la politique restrictive d'insertion exige un acteur, l'état « prepare » et aucun envoi", () => {
    expect(code()).toMatch(
      /CREATE POLICY acteur_obligatoire_insert ON "public"\."rapports_mensuels" AS RESTRICTIVE FOR INSERT TO console_app WITH CHECK \(NULLIF\(current_setting\('app\.acteur', true\), ''\) IS NOT NULL AND etat = 'prepare' AND envoye_par IS NULL\)/,
    );
  });

  it("[B-407] la politique restrictive d'envoi n'accepte que prepare → envoye, par l'acteur, à l'heure de la transaction", () => {
    expect(code()).toMatch(
      /CREATE POLICY envoi_une_seule_fois ON "public"\."rapports_mensuels" AS RESTRICTIVE FOR UPDATE TO console_app USING \(etat = 'prepare'\) WITH CHECK \(etat = 'envoye' AND envoye_par = NULLIF\(current_setting\('app\.acteur', true\), ''\) AND envoye_le = now\(\)\)/,
    );
  });

  it("[B-406] aucun droit n'est donné aux autres rôles ni à PUBLIC, et aucun DELETE n'est accordé", () => {
    expect(code()).not.toMatch(/\bTO\s+(console_equipe|console_lecture|PUBLIC)\b/i);
    expect(code()).not.toMatch(/GRANT\s+(ALL|DELETE|TRUNCATE)/i);
  });

  it("[B-407] le journal range la migration sous son sujet, avec son instantané", () => {
    const journal = JSON.parse(readFileSync(new URL("meta/_journal.json", dossier), "utf8")) as { entries: { idx: number; tag: string }[] };
    const nom = (fichier() ?? "").replace(/\.sql$/, "");
    const entree = journal.entries.find((e) => e.tag === nom);
    expect(entree).toBeDefined();
    expect(entree?.idx).toBe(journal.entries.findIndex((e) => e.tag === nom));
    const numero = nom.slice(0, 4);
    expect(readdirSync(new URL("meta/", dossier))).toContain(`${numero}_snapshot.json`);
  });
});
