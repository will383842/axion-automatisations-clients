import { describe, expect, it } from "vitest";
import { releverBase, releverLot, SQL_INSERT_MESURE, type MesureBase, type PortsReleve } from "./releve.js";

const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";
const maintenant = new Date("2026-11-06T12:00:00Z");

function ports(ecrites: { tenantId: string; mesure: MesureBase }[], surcharge: Partial<PortsReleve> = {}): PortsReleve {
  return {
    tailleBase: async (b) => (b === "cli_lemoine" ? 5_000_000 : 7_000_000),
    quotaOctets: async () => 100_000_000,
    connexions: async () => ({ actives: 6, limite: 20 }),
    lignesMortes: async () => 120,
    requetesLentes: async () => 3,
    versionStructure: async () => "modele_v1",
    ageSauvegardeS: async (t) => (t === T1 ? 3_600 : 7_200),
    ageTestRestaurationS: async () => 86_400,
    ecrire: async (tenantId, mesure) => void ecrites.push({ tenantId, mesure }),
    maintenant: () => maintenant,
    ...surcharge,
  };
}

describe("relève des bases", () => {
  it("[A-263] la relève de deux bases fictives écrit taille, connexions, lignes mortes, version, âge de sauvegarde et de restauration", async () => {
    const ecrites: { tenantId: string; mesure: MesureBase }[] = [];
    await releverLot(ports(ecrites), [{ tenantId: T1, nomBase: "cli_lemoine" }, { tenantId: T2, nomBase: "cli_marceau" }]);
    expect(ecrites).toHaveLength(2);
    expect(ecrites[0]).toEqual({
      tenantId: T1,
      mesure: { base: "cli_lemoine", debut: maintenant, tailleOctets: 5_000_000, quotaOctets: 100_000_000, connexions: 6, limiteConnexions: 20, requetesLentes: 3, lignesMortes: 120, versionStructure: "modele_v1", ageSauvegardeS: 3_600, ageTestRestaurationS: 86_400 },
    });
    expect(ecrites[1]!.mesure).toMatchObject({ base: "cli_marceau", tailleOctets: 7_000_000, ageSauvegardeS: 7_200 });
  });

  it("[A-263] une mesure douteuse n'est jamais écrite et la relève des autres bases continue", async () => {
    const ecrites: { tenantId: string; mesure: MesureBase }[] = [];
    const p = ports(ecrites, { tailleBase: async (b) => (b === "cli_lemoine" ? -1 : 10) });
    const r = await releverLot(p, [{ tenantId: T1, nomBase: "cli_lemoine" }, { tenantId: T2, nomBase: "cli_marceau" }]);
    expect(ecrites.map((e) => e.mesure.base)).toEqual(["cli_marceau"]);
    expect(r.echecs).toEqual(["cli_lemoine"]);
  });

  it("[A-263] une base dont le nom n'a pas la forme cli_<id> est refusée sans être lue", async () => {
    const lues: string[] = [];
    await expect(releverBase(ports([], { tailleBase: async (b) => (lues.push(b), 1) }), { tenantId: T1, nomBase: "postgres; DROP" })).rejects.toThrow(/nom de base/);
    expect(lues).toEqual([]);
  });

  it("[A-263] la requête d'écriture ne porte que des mesures : ni texte de requête, ni ligne de travail", () => {
    expect(SQL_INSERT_MESURE).toContain("INSERT INTO mesures_bases");
    expect(SQL_INSERT_MESURE).not.toMatch(/\bquery\b|\bSELECT\b/i);
  });

  it("[A-263] @isolation le rôle donnees_supervision n'a aucun droit sur les tables des clients (texte des droits)", async () => {
    const { DROITS_SUPERVISION } = await import("./releve.js");
    expect(DROITS_SUPERVISION.join("\n")).not.toMatch(/ALL TABLES|SELECT ON (public|commun|trace)\./i);
    expect(DROITS_SUPERVISION.every((d) => /pg_monitor|pg_stat_statements|CONNECT/i.test(d))).toBe(true);
  });
});
