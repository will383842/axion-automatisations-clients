import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { deposer, idTache, type FileMinimale } from "./files.js";

const TENANT_A = "3f2b8c1e-5a4d-4e6f-9b7a-1c2d3e4f5a6b";
const TENANT_B = "7a9c0d2e-1b3f-4a5c-8d6e-0f1a2b3c4d5e";

function fausseFile() {
  const ajouts: { nom: string; donnees: unknown; opts: { jobId?: string } }[] = [];
  const file: FileMinimale = {
    name: "essai",
    add: (nom, donnees, opts) => {
      ajouts.push({ nom, donnees, opts: opts ?? {} });
      return Promise.resolve({ id: opts?.jobId });
    },
  };
  return { file, ajouts };
}

describe("files : jobId dérivé de l'intention", () => {
  it("[LOT1-files] la même intention donne le même jobId", () => {
    const a = idTache({ tenantId: TENANT_A, type: "relance", cle: "dossier-12" });
    const b = idTache({ cle: "dossier-12", type: "relance", tenantId: TENANT_A });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("[LOT1-files] une autre clé, un autre type ou un autre client donne un autre jobId", () => {
    const base = idTache({ tenantId: TENANT_A, type: "relance", cle: "dossier-12" });
    expect(idTache({ tenantId: TENANT_A, type: "relance", cle: "dossier-13" })).not.toBe(base);
    expect(idTache({ tenantId: TENANT_A, type: "rappel", cle: "dossier-12" })).not.toBe(base);
    expect(idTache({ tenantId: TENANT_B, type: "relance", cle: "dossier-12" })).not.toBe(base);
  });

  it("[LOT1-files] les champs ne se confondent pas par concaténation", () => {
    expect(idTache({ tenantId: TENANT_A, type: "a", cle: "b|c" })).not.toBe(idTache({ tenantId: TENANT_A, type: "a|b", cle: "c" }));
  });

  it("[LOT1-files] le jobId est toujours fourni à la file", async () => {
    const { file, ajouts } = fausseFile();
    await deposer(file, { tenantId: TENANT_A, type: "relance", cle: "dossier-12" }, { texte: "x" });
    expect(ajouts).toHaveLength(1);
    expect(ajouts[0]?.opts.jobId).toBe(idTache({ tenantId: TENANT_A, type: "relance", cle: "dossier-12" }));
    expect(ajouts[0]?.donnees).toMatchObject({ tenantId: TENANT_A });
  });
});

describe("files : tenantId obligatoire", () => {
  it("[LOT1-files] une tâche sans tenantId est refusée", async () => {
    const { file, ajouts } = fausseFile();
    // @ts-expect-error tenantId manquant exprès
    await expect(deposer(file, { type: "relance", cle: "dossier-12" }, {})).rejects.toThrow(/tenantId/);
    expect(ajouts).toHaveLength(0);
  });

  it("[LOT1-files] un tenantId qui n'est pas un UUID est refusé", async () => {
    const { file, ajouts } = fausseFile();
    for (const mauvais of ["", "client-1", "3f2b8c1e-5a4d-4e6f-9b7a", "' OR 1=1 --", TENANT_A + "x"]) {
      await expect(deposer(file, { tenantId: mauvais, type: "relance", cle: "k" }, {})).rejects.toThrow(/tenantId/);
    }
    expect(ajouts).toHaveLength(0);
  });

  it("[LOT1-files] les données ne peuvent pas écraser le tenantId de l'intention", async () => {
    const { file, ajouts } = fausseFile();
    await deposer(file, { tenantId: TENANT_A, type: "relance", cle: "k" }, { tenantId: TENANT_B });
    expect(ajouts[0]?.donnees).toMatchObject({ tenantId: TENANT_A });
  });

  it("[LOT1-files] une clé ou un type vide est refusé", async () => {
    const { file, ajouts } = fausseFile();
    await expect(deposer(file, { tenantId: TENANT_A, type: "", cle: "k" }, {})).rejects.toThrow();
    await expect(deposer(file, { tenantId: TENANT_A, type: "t", cle: "" }, {})).rejects.toThrow();
    expect(ajouts).toHaveLength(0);
  });
});

describe("licence de BullMQ", () => {
  it("[A-326] le paquet bullmq installé n'est pas BullMQ Pro", () => {
    const require = createRequire(import.meta.url);
    const p = require("bullmq/package.json") as { name: string; license: string; dependencies?: Record<string, string> };
    expect(p.name).toBe("bullmq");
    expect(p.license).toBe("MIT");
    expect(Object.keys(p.dependencies ?? {}).some((n) => /bullmq-pro/.test(n))).toBe(false);
    expect(() => require.resolve("@taskforcesh/bullmq-pro")).toThrow();
  });
});
