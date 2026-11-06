import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { attribuerCellule, ETAT_VOULU_DE, resoudreInstance } from "./portees.js";

type Appel = { sql: string; valeurs: unknown[] };
// Faux pool : enregistre les requêtes ; `repondre` donne les lignes (ou le nombre de lignes modifiées) de chaque SELECT / UPDATE.
function fauxPool(repondre: (sql: string, valeurs: unknown[]) => { rows?: unknown[]; rowCount?: number } = () => ({ rows: [], rowCount: 0 })) {
  const appels: Appel[] = [];
  const client = {
    async query(sql: string, valeurs: unknown[] = []) {
      appels.push({ sql, valeurs });
      return /^(BEGIN|COMMIT|ROLLBACK|SELECT set_config)/.test(sql) ? { rows: [], rowCount: 0 } : repondre(sql, valeurs);
    },
    release() {},
  };
  return { pool: { connect: async () => client } as unknown as Pool, appels };
}
const metier = (a: Appel[]) => a.filter((x) => !/^(BEGIN|COMMIT|ROLLBACK|SELECT set_config)/.test(x.sql));
const TENANT = randomUUID();
const INSTANCE = randomUUID();
const APPELANT = { acteur: "agent-essai", ip: "192.0.2.17" };

describe("portées d'une instance (C-017)", () => {
  it("[C-017] la correspondance des états : active→actif, pause→pause, erreur→pause, livree→arrete", () => {
    expect(ETAT_VOULU_DE).toEqual({ active: "actif", pause: "pause", erreur: "pause", livree: "arrete" });
  });

  it("[C-017] @isolation le tenant_id vient de la base : SELECT tenant_id, cellule_code … WHERE id = $1 LIMIT 2, en lecture seule, avec le seul identifiant", async () => {
    const { pool, appels } = fauxPool(() => ({ rows: [{ tenant_id: TENANT, cellule_code: "cellule-un", etat: "active", arret_envois: false, version_etat_voulu: 4 }] }));
    await expect(resoudreInstance(pool, INSTANCE)).resolves.toEqual({ tenantId: TENANT, celluleCode: "cellule-un", etat: "active", arretEnvois: false, version: 4 });
    expect(appels[0]?.sql).toBe("BEGIN READ ONLY");
    const [lecture] = metier(appels);
    expect(lecture?.sql).toMatch(/SELECT tenant_id, cellule_code, etat, arret_envois, version_etat_voulu FROM instances WHERE id = \$1 LIMIT 2/);
    expect(lecture?.valeurs).toEqual([INSTANCE]);
  });

  it("[C-017] une instance sans cellule rend celluleCode null", async () => {
    const { pool } = fauxPool(() => ({ rows: [{ tenant_id: TENANT, cellule_code: null, etat: "pause", arret_envois: true, version_etat_voulu: 0 }] }));
    await expect(resoudreInstance(pool, INSTANCE)).resolves.toEqual({ tenantId: TENANT, celluleCode: null, etat: "pause", arretEnvois: true, version: 0 });
  });

  it("[C-017] @isolation zéro ligne ou plus d'une ligne (id non unique seul) : introuvable", async () => {
    await expect(resoudreInstance(fauxPool(() => ({ rows: [] })).pool, INSTANCE)).resolves.toBeNull();
    const deux = [{ tenant_id: TENANT, cellule_code: "a" }, { tenant_id: randomUUID(), cellule_code: "a" }];
    await expect(resoudreInstance(fauxPool(() => ({ rows: deux })).pool, INSTANCE)).resolves.toBeNull();
  });

  it("[C-017] un identifiant qui n'est pas un UUID est introuvable sans requête", async () => {
    const { pool, appels } = fauxPool();
    for (const id of ["", "x", "1; DROP TABLE instances", "../etc"]) await expect(resoudreInstance(pool, id), id).resolves.toBeNull();
    expect(appels).toEqual([]);
  });

  it("[C-017] attribuerCellule rend vrai si la fonction réussit, faux sur P0002 (même erreur, cellule ou instance inconnue), et relance toute autre erreur", async () => {
    const reussite = fauxPool(() => ({ rows: [], rowCount: 1 }));
    await expect(attribuerCellule(reussite.pool, { tenantId: TENANT, instanceId: INSTANCE, cellule: "cellule-un" }, APPELANT)).resolves.toBe(true);
    const refus = (code: string) => fauxPool(() => { throw Object.assign(new Error("attribution refusée"), { code }); }).pool;
    await expect(attribuerCellule(refus("P0002"), { tenantId: TENANT, instanceId: INSTANCE, cellule: null }, APPELANT)).resolves.toBe(false);
    await expect(attribuerCellule(refus("42501"), { tenantId: TENANT, instanceId: INSTANCE, cellule: null }, APPELANT)).rejects.toMatchObject({ code: "42501" });
  });

  it("[C-017] attribuerCellule refuse une cellule mal formée avant toute requête", async () => {
    const { pool, appels } = fauxPool();
    for (const cellule of ["", "A", "a_b", "a/b", "-a", "a--b", "a".repeat(65)]) {
      await expect(attribuerCellule(pool, { tenantId: TENANT, instanceId: INSTANCE, cellule }, APPELANT), cellule).rejects.toThrow();
    }
    expect(appels).toEqual([]);
  });
});

describe("attribution de cellule par la fonction de l'équipe (migration 0019)", () => {
  it("[C-017] attribuerCellule appelle attribuer_cellule par le pool de l'équipe, jamais un UPDATE direct", async () => {
    const { pool, appels } = fauxPool(() => ({ rows: [], rowCount: 1 }));
    await attribuerCellule(pool, { tenantId: TENANT, instanceId: INSTANCE, cellule: "cellule-un" }, APPELANT);
    const [appel] = metier(appels);
    expect(appel?.sql).toMatch(/SELECT public\.attribuer_cellule\(\$1, \$2\)/);
    expect(appel?.sql).not.toMatch(/UPDATE/i);
    expect(appel?.valeurs).toEqual([INSTANCE, "cellule-un"]);
    expect(appels[0]?.sql).toBe("BEGIN");
    expect(appels.find((a) => /app\.tenant_id/.test(a.sql))?.valeurs).toEqual([TENANT]);
    expect(appels.find((a) => /app\.acteur/.test(a.sql))?.valeurs).toContain("agent-essai");
  });
});
