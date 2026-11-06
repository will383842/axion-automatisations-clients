import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { appliquerExecution, SQL_AGREGAT, SQL_SANTE } from "./evenements.js";

const ici = dirname(fileURLToPath(import.meta.url));
const T = "11111111-1111-4111-8111-111111111111";
const I = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function sources(dossier: string): string[] {
  return readdirSync(dossier, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? sources(join(dossier, d.name)) : d.name.endsWith(".ts") && !/\.test\.ts$/.test(d.name) ? [join(dossier, d.name)] : []));
}

describe("événements d'exécution", () => {
  it("[B-381] aucun module de supervision n'appelle l'exécuteur", () => {
    for (const f of sources(join(ici, ".."))) {
      const texte = readFileSync(f, "utf8");
      expect(texte, f).not.toMatch(/from\s+["'][^"']*(executeur\/(client|http)|apps\/executeur)/);
      expect(texte, f).not.toMatch(/\bfetch\(/);
    }
  });

  it("[B-381] un événement terminé met à jour l'agrégat du jour et la santé dans la même transaction", async () => {
    const requetes: { sql: string; valeurs: unknown[] }[] = [];
    const client = { query: async (sql: string, valeurs: unknown[]) => void requetes.push({ sql, valeurs }) };
    await appliquerExecution(client as never, { tenantId: T, instanceId: I, statut: "echec", dureeMs: 1200, coutMicroCentimes: 5, finLe: new Date("2026-11-06T10:00:00Z"), prochaineAttendueLe: null }, "cellule:auto-run-1");
    expect(requetes.map((r) => r.sql)).toEqual([SQL_AGREGAT, SQL_SANTE]);
    expect(requetes[0]!.valeurs).toEqual([T, I, "2026-11-06", 1, 1200, 5, "cellule:auto-run-1"]);
    expect(requetes[1]!.valeurs).toEqual([T, I, null, null]);
  });

  it("[B-381] une réussite pose la dernière réussite et la prochaine attendue", async () => {
    const requetes: { valeurs: unknown[] }[] = [];
    const client = { query: async (_s: string, valeurs: unknown[]) => void requetes.push({ valeurs }) };
    const fin = new Date("2026-11-06T10:00:00Z");
    const suivante = new Date("2026-11-06T11:00:00Z");
    await appliquerExecution(client as never, { tenantId: T, instanceId: I, statut: "reussie", dureeMs: 10, coutMicroCentimes: 0, finLe: fin, prochaineAttendueLe: suivante }, "cellule:auto-run-1");
    expect(requetes[0]!.valeurs.slice(3, 4)).toEqual([0]);
    expect(requetes[1]!.valeurs).toEqual([T, I, fin, suivante]);
  });
});
