import { describe, expect, it } from "vitest";
import { codeSchema, deployerTablesModule, type DepsTablesModule, type InstanceDuModule } from "./tables-module.ts";
import type { BaseRegistre } from "../donnees/vagues.ts";

// Tables d'un module par les vagues de T2-38 (T4-28b2, ADR 0125) : l'adaptateur de ports ne touche pas vagues.ts.
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
const base = (id: string, tenantId: string, nomBase: string): BaseRegistre => ({ id, tenantId, nomBase, versionStructure: 1, etat: "active" });
const REGISTRE = [base("b1", A, "cli_a"), base("b2", B, "cli_b"), base("b3", C, "cli_c")];
const instance = (tenantId: string, instanceId: string, etat = "pause"): InstanceDuModule => ({ tenantId, instanceId, versionDepartId: "v1", configurationId: "c1", etat });

function monde(options: { instances?: InstanceDuModule[]; sql?: string[]; echoue?: string[] } = {}) {
  const journal: string[] = [];
  const lignes: Record<string, unknown>[] = [];
  const appliquee = new Map<string, number>(REGISTRE.map((b) => [b.nomBase, 1]));
  const d: DepsTablesModule = {
    code: "gestion-devis",
    versionCibleId: "v2",
    versionCible: 2,
    config: { recette: [], internes: [] },
    async migrationsSql() { journal.push("migrationsSql"); return options.sql ?? ['CREATE TABLE "devis" ("id" uuid PRIMARY KEY);']; },
    async registre() { journal.push("registre"); return REGISTRE; },
    async instances() { return options.instances ?? [instance(A, "i1"), instance(B, "i2", "livree")]; },
    async versionAppliquee(nomBase) { return appliquee.get(nomBase) ?? 0; },
    async dossierMigrations() { return "/artefact/migrations"; },
    async migrerBase(nomBase, v, o) {
      journal.push(`migrer:${nomBase}:${v}:${o.module}`);
      if (options.echoue?.includes(nomBase)) throw new Error("adresse interne 10.0.0.1");
      appliquee.set(nomBase, v);
    },
    async ecrireDeploiement(l) { lignes.push({ ...l }); },
    async graine() { return undefined; },
    async enregistrerGraine() {},
    tirerGraine: () => 7,
    alertes: { async alerter(a) { journal.push(`alerte:${a.type}:${a.clientId}`); } },
  };
  return { d, journal, lignes };
}

describe("tables du module par les vagues", () => {
  it("[C-244] codeSchema transforme les tirets en soulignés et refuse un code de plus de 31 caractères", () => {
    expect(codeSchema("gestion-devis")).toBe("gestion_devis");
    expect(codeSchema("ab")).toBe("ab");
    expect(() => codeSchema("a".repeat(32))).toThrow();
    expect(codeSchema("a".repeat(31))).toBe("a".repeat(31));
    expect(() => codeSchema("Gestion")).toThrow();
    expect(() => codeSchema("a_b")).toThrow();
  });

  it("[C-244] les tables déclarées par le module sont confiées aux vagues pour les seules bases des clients qui ont une instance de ce module", async () => {
    const { d, journal } = monde();
    const r = await deployerTablesModule(d);
    // Le client A a une instance en pause ; B n'a qu'une instance livrée ; C n'en a aucune : seule la base de A migre, dans le schéma a_gestion_devis.
    expect(journal.filter((x) => x.startsWith("migrer:"))).toEqual(["migrer:cli_a:2:gestion_devis"]);
    expect(r.echecs).toEqual([]);
  });

  it("[A-300] une migration refusée par la garde n'ouvre aucune connexion et ne lit pas le registre", async () => {
    const { d, journal } = monde({ sql: ['DROP TABLE "devis";'] });
    await expect(deployerTablesModule(d)).rejects.toMatchObject({ code: "regle_metier" });
    expect(journal).toEqual(["migrationsSql"]);
  });

  it("[A-228] une base en échec reste en quarantaine : une ligne quarantaine par instance, une alerte, aucun détail de l'erreur", async () => {
    const { d, journal, lignes } = monde({ echoue: ["cli_a"] });
    const r = await deployerTablesModule(d);
    expect(r.echecs).toEqual(["cli_a"]);
    expect(lignes).toEqual([{ tenantId: A, instanceId: "i1", versionDepartId: "v1", versionCibleId: "v2", configurationId: "c1", resultat: "quarantaine", cause: "tables", vague: expect.any(Number) }]);
    expect(journal).toContain(`alerte:migration_echec:${A}`);
    expect(JSON.stringify([lignes, journal])).not.toContain("10.0.0.1");
  });

  it("[A-228] une base migrée donne une ligne ok sans cause", async () => {
    const { d, lignes } = monde();
    await deployerTablesModule(d);
    expect(lignes).toEqual([expect.objectContaining({ tenantId: A, instanceId: "i1", resultat: "ok", cause: null })]);
  });
});
