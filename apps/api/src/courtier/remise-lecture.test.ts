import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { PortsIdentifiants } from "./identifiants-base.js";
import { remettreBaseLecture } from "./remise-lecture.js";

const A = randomUUID();
const idA = A.replaceAll("-", "").slice(0, 12);
const ports = (): PortsIdentifiants => ({
  proprietaireTache: async () => A,
  base: async () => ({ etat: "active", grappe: "donnees-1" }),
  gelActif: async () => false,
  hote: () => "pgbouncer-donnees.test",
  limites: async () => ({ statementTimeout: true, connectionLimit: 2 }),
  versionRole: async () => 4,
  validiteRole: async () => new Date("2027-02-01T00:00:00Z"),
  secret: async () => ({ motDePasse: "mot-de-passe-d-essai", version: 4 }),
  journal: { tracer: () => undefined },
  maintenant: () => new Date("2027-01-10T10:00:00Z"),
});

describe("route de remise base_lecture", () => {
  it("[C-624] le type de remise est fixe base_lecture et le nom du rôle n'est jamais transmis", async () => {
    const r = await remettreBaseLecture(ports(), { tenantId: A, idTache: "tache-1" });
    expect(r.type).toBe("base_lecture");
    expect(Object.keys(r).sort()).toEqual(["base", "expire", "hote", "motDePasse", "type", "valideJusqua"]);
    expect(r.base).toBe(`cli_${idA}`);
    expect(JSON.stringify(r)).not.toMatch(/_lecture|_app|_proprietaire/);
  });

  it("[C-624] @isolation un champ genre, role ou chemin ajouté à la requête est refusé (demande_invalide), rien n'est lu", async () => {
    for (const extra of [{ genre: "app" }, { role: `cli_${idA}_proprietaire` }, { type: "base_app" }, { chemin: "../proprietaire" }]) {
      let lu = 0;
      const p = { ...ports(), secret: async () => { lu++; return { motDePasse: "x", version: 4 }; } };
      await expect(remettreBaseLecture(p, { tenantId: A, idTache: "tache-1", ...extra })).rejects.toMatchObject({ code: "demande_invalide" });
      expect(lu).toBe(0);
    }
    for (const brut of [null, [], "x", { tenantId: A }, { idTache: "t" }]) await expect(remettreBaseLecture(ports(), brut)).rejects.toMatchObject({ code: "demande_invalide" });
  });

  it("[A-169] une remise rejouée après un gel est refusée (base_gelee)", async () => {
    let etat: "active" | "gelee" = "active";
    const p = { ...ports(), base: async () => ({ etat, grappe: "donnees-1" }) };
    await expect(remettreBaseLecture(p, { tenantId: A, idTache: "tache-1" })).resolves.toMatchObject({ type: "base_lecture" });
    etat = "gelee";
    await expect(remettreBaseLecture(p, { tenantId: A, idTache: "tache-1" })).rejects.toMatchObject({ code: "base_gelee" });
  });
});
