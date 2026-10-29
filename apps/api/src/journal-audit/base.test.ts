import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { creerJournalAuditBase } from "./base.js";

const CLIENT_A = "6f1c3a52-8d1e-4b7a-9c20-3e5d7a1b0c11";
type Appel = [string, (unknown[] | undefined)?];

function fauxPool(echecSur?: string) {
  const appels: Appel[] = [];
  const client = {
    query: vi.fn(async (texte: string, valeurs?: unknown[]) => {
      appels.push([texte, valeurs]);
      if (echecSur && texte.startsWith(echecSur)) throw new Error("panne simulée");
      return { rows: [] };
    }),
    release: vi.fn(),
  };
  return { pool: { connect: vi.fn(async () => client) } as unknown as Pool, client, appels };
}

describe("journal d'audit en base (port)", () => {
  it("[A-131] avec un client, écrit par audit_ajouter dans la transaction du client actif, motif et montant dans nouvelle", async () => {
    const { pool, appels } = fauxPool();
    await creerJournalAuditBase(pool).ecrire({ action: "blocage_cle", tenantId: CLIENT_A, parQui: "systeme", motif: "plafond atteint", montantConsommeMicroCentimes: 1234 });
    expect(appels.map((a) => a[0])).toEqual(["BEGIN", expect.stringContaining("lock_timeout"), "SELECT set_config('app.tenant_id', $1, true)", expect.stringContaining("public.audit_ajouter"), "COMMIT"]);
    expect(appels[3]?.[1]).toEqual([CLIENT_A, "systeme", "blocage_cle", "cle_api", JSON.stringify({ motif: "plafond atteint", montant_consomme_micro_centimes: 1234 })]);
  });

  it("[A-131] sans client (action de l'équipe), écrit dans une transaction sans client actif et sans montant", async () => {
    const { pool, appels } = fauxPool();
    await creerJournalAuditBase(pool).ecrire({ action: "levee_budget_jour", parQui: "admin-essai", motif: "reprise" });
    expect(appels.map((a) => a[0])).toEqual(["BEGIN", expect.stringContaining("public.audit_ajouter"), "COMMIT"]);
    expect(appels[1]?.[1]).toEqual([null, "admin-essai", "levee_budget_jour", "budget_jour", JSON.stringify({ motif: "reprise" })]);
  });

  it("[A-131] un montant qui n'est pas un entier est refusé avant toute connexion", async () => {
    const { pool } = fauxPool();
    await expect(creerJournalAuditBase(pool).ecrire({ action: "blocage_cle", tenantId: CLIENT_A, parQui: "systeme", motif: "m", montantConsommeMicroCentimes: 12.5 })).rejects.toThrow(/entier/);
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it("[A-131] si l'annulation échoue, la connexion est détruite au lieu d'être rendue au pool", async () => {
    const { pool, client } = fauxPool("SELECT public.audit_ajouter");
    await expect(creerJournalAuditBase(pool).ecrire({ action: "levee_budget_jour", parQui: "admin-essai", motif: "reprise" })).rejects.toThrow("panne simulée");
    expect(client.release).toHaveBeenCalledWith(undefined);
  });

  it("[A-131] un parQui vide, trop long ou avec caractère de contrôle (saut de ligne, nul) est refusé avant toute connexion", async () => {
    for (const parQui of ["", "   ", "a".repeat(129), "admin" + String.fromCharCode(10) + "forge", "admin" + String.fromCharCode(0) + "forge"]) {
      const { pool } = fauxPool();
      await expect(creerJournalAuditBase(pool).ecrire({ action: "levee_budget_jour", parQui, motif: "m" })).rejects.toThrow(/acteur/);
      expect(pool.connect).not.toHaveBeenCalled();
    }
  });
});
