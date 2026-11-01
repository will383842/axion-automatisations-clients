import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Contrôles de texte sur la migration du journal d'audit ; la preuve contre PostgreSQL est dans audit.int.test.ts (job socle-integration).
const sql = readFileSync(new URL("../../drizzle/0001_journal_audit_fonctions.sql", import.meta.url), "utf8");
const instructions = sql.split("--> statement-breakpoint").map((i) => i.trim());

describe("migration du journal d'audit", () => {
  it("[C-028] pose les déclencheurs d'ajout seul (UPDATE, DELETE, TRUNCATE) et FORCE la RLS", () => {
    expect(sql).toContain('ALTER TABLE "public"."journal_audit" FORCE ROW LEVEL SECURITY');
    expect(sql).toMatch(/CREATE TRIGGER \w+ BEFORE UPDATE OR DELETE ON "public"\."journal_audit" FOR EACH ROW EXECUTE FUNCTION public\.audit_refuser\(\)/);
    expect(sql).toMatch(/CREATE TRIGGER \w+ BEFORE TRUNCATE ON "public"\."journal_audit" FOR EACH STATEMENT EXECUTE FUNCTION public\.audit_refuser\(\)/);
  });

  it("[C-028] aucun droit d'écriture direct sur la table : seulement SELECT, et seulement pour console_app et console_equipe", () => {
    const droits = instructions.filter((i) => /^GRANT .* ON (TABLE )?"public"\."journal_audit"/.test(i));
    expect(droits).toEqual(['GRANT SELECT ON TABLE "public"."journal_audit" TO console_app, console_equipe;']);
    expect(sql).not.toMatch(/GRANT[^;]*\b(INSERT|UPDATE|DELETE|TRUNCATE|ALL)\b[^;]*journal_audit/i);
  });

  it("[C-028] seule audit_ajouter est ouverte à console_app ; audit_inserer n'est ouverte à personne", () => {
    const execute = instructions.filter((i) => i.startsWith("GRANT EXECUTE"));
    expect(execute.filter((i) => i.endsWith("TO console_app;")).map((i) => /public\.(\w+)\(/.exec(i)?.[1])).toEqual(["audit_ajouter"]);
    expect(execute.some((i) => i.includes("audit_inserer"))).toBe(false);
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.audit_inserer\([^)]*\) FROM PUBLIC/);
  });

  it("[C-028] le déclencheur d'audit des tables de client n'est pas SECURITY DEFINER, les deux fonctions d'écriture le sont avec un chemin fixe", () => {
    const fonction = (nom: string) => (instructions.find((i) => i.startsWith(`CREATE FUNCTION public.${nom}(`)) ?? "").split("AS $fonction$")[0] ?? "";
    expect(fonction("audit_ecrire")).not.toContain("SECURITY DEFINER");
    for (const nom of ["audit_inserer", "audit_ajouter"]) {
      expect(fonction(nom), nom).toContain("SECURITY DEFINER");
      expect(fonction(nom), nom).toContain("SET search_path = pg_catalog, pg_temp");
    }
  });
});

// Réserves de l'audit de la PR 95 (T2-01b) : la preuve contre PostgreSQL est dans clients.int.test.ts.
const reserves = () => readFileSync(new URL("../../drizzle/0003_journal_audit_reserves_t201b.sql", import.meta.url), "utf8");

describe("migration 0003 du journal d'audit (réserves de la PR 95)", () => {
  it("[A-131] contrôle d'abord les adresses IP avec masque et refuse la migration s'il en reste (ADR 0042, R2)", () => {
    const premiere = reserves().split("--> statement-breakpoint")[0] ?? "";
    expect(premiere).toContain("masklen(ip)");
    expect(premiere).toContain("adresse IP avec masque");
  });

  it("[A-131] la classe de caractères refusés compte U+180E, U+00AD et U+3164 (acteur et identifiant d'entité)", () => {
    for (const code of ["180E", "00AD", "3164"]) expect(reserves().match(new RegExp(`\\\\u${code}`, "gi"))?.length, code).toBeGreaterThanOrEqual(2);
  });

  it("[A-131] audit_ecrire borne ce qu'il copie sans faire échouer l'écriture métier ; il reste sans SECURITY DEFINER", () => {
    const f = (reserves().split("--> statement-breakpoint").find((i) => i.includes("FUNCTION public.audit_ecrire(")) ?? "");
    expect(f).toContain("262144");
    expect(f.split("AS $fonction$")[0]).not.toContain("SECURITY DEFINER");
  });
});
