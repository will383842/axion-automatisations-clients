import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { confirmerAccuse, envoyerPreavis, lienAccuse } from "./accuse.js";

const T = "11111111-1111-4111-8111-111111111111";
const AUTRE = "22222222-2222-4222-8222-222222222222";
const signer = (texte: string) => createHmac("sha256", "cle-d-essai").update(texte).digest("hex");

describe("accusé de réception du préavis", () => {
  it("[A-255] @envoi le préavis part avec un lien unique de confirmation, tracé au journal, sans texte ni adresse dans la trace", async () => {
    const deposes: { type: string; cle: string; lien: string }[] = [];
    const traces: Record<string, unknown>[] = [];
    await envoyerPreavis({ envois: { deposerPreavis: async (m) => void deposes.push(m) }, gel: { gelActif: async () => false }, signer, baseLien: "https://portail.exemple.fr/accuse", tracer: async (e) => void traces.push(e) })(T, 20, "2027-01-10");
    expect(deposes).toEqual([{ type: "preavis_j20", clientId: T, cle: `preavis_j20:${T}:2027-01-10`, categorie: "service", lien: lienAccuse(signer, "https://portail.exemple.fr/accuse", T, 20) }]);
    expect(traces).toEqual([{ type: "preavis_depose", tenantId: T, jour: 20 }]);
    expect(lienAccuse(signer, "https://portail.exemple.fr/accuse", T, 20)).not.toBe(lienAccuse(signer, "https://portail.exemple.fr/accuse", T, 27));
  });

  it("[C-609] pendant un gel le préavis n'est pas déposé", async () => {
    const deposes: unknown[] = [];
    await expect(envoyerPreavis({ envois: { deposerPreavis: async (m) => void deposes.push(m) }, gel: { gelActif: async () => true }, signer, baseLien: "https://portail.exemple.fr/accuse", tracer: async () => undefined })(T, 1, "2027-01-10")).rejects.toMatchObject({ motif: "gel_pour_litige" });
    expect(deposes).toEqual([]);
  });

  it("[A-255] le clic sur le lien enregistre l'accusé une seule fois ; un jeton d'un autre client ou d'un autre jour est refusé", async () => {
    const accuses: string[] = [];
    const traces: Record<string, unknown>[] = [];
    const confirmer = confirmerAccuse({ signer, enregistrer: async (t, j, preuve) => { accuses.push(`${t}:${j}:${preuve}`); return accuses.length === 1; }, tracer: async (e) => void traces.push(e), maintenant: () => new Date("2027-01-11T10:00:00Z") });
    const jeton = signer(`accuse:${T}:1`);
    expect(await confirmer(AUTRE, 1, jeton)).toBe(false);
    expect(await confirmer(T, 20, jeton)).toBe(false);
    expect(await confirmer(T, 1, "x".repeat(10))).toBe(false);
    expect(await confirmer(T, 1, jeton)).toBe(true);
    expect(await confirmer(T, 1, jeton)).toBe(false);
    expect(accuses).toEqual([`${T}:1:recu:2027-01-11T10:00:00.000Z`, `${T}:1:recu:2027-01-11T10:00:00.000Z`]);
    expect(traces.filter((t) => t["type"] === "accuse_recu")).toHaveLength(1);
  });
});
