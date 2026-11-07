import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FRAGMENTS_INTEGRATION, charge, fichiersIntegration, lirePoids, partitionner } from "./partition-integration.ts";

// Partition du projet « integration » en fragments de charge égale (ADR 0121, qui complète l'ADR 0118).
const fichiers = fichiersIntegration();
const poids = lirePoids();
const parts = partitionner(fichiers, FRAGMENTS_INTEGRATION, poids);

describe("partition du socle d'intégration", () => {
  it("[A-066] chaque fichier d'intégration est dans un seul fragment, aucun n'est perdu", () => {
    expect(fichiers.length).toBeGreaterThan(70);
    expect(parts).toHaveLength(FRAGMENTS_INTEGRATION);
    const tous = parts.flat();
    expect(new Set(tous).size).toBe(tous.length);
    expect([...tous].sort()).toEqual([...fichiers].sort());
    for (const p of parts) expect(p.length).toBeGreaterThan(0);
  });
  it("[A-066] la charge estimée est équilibrée : écart d'au plus 90 s entre le fragment le plus long et le plus court", () => {
    const charges = parts.map((p) => charge(p, poids));
    expect(Math.max(...charges) - Math.min(...charges)).toBeLessThanOrEqual(90);
    // Plus long fragment estimé : sous 160 s de tests, soit environ 5 min avec le surcoût fixe mesuré.
    expect(Math.max(...charges)).toBeLessThanOrEqual(160);
  });
  it("[A-066] la partition est stable : même entrée, même résultat, quel que soit l'ordre des fichiers", () => {
    expect(partitionner([...fichiers].reverse(), FRAGMENTS_INTEGRATION, poids)).toEqual(parts);
  });
  it("[A-066] la liste des poids ne nomme que des fichiers qui existent, avec un poids positif", () => {
    expect(existsSync("ops/socle/poids-integration.json")).toBe(true);
    for (const [f, p] of Object.entries(poids.fichiers)) {
      expect(fichiers, f).toContain(f);
      expect(p, f).toBeGreaterThan(0);
    }
  });
  it("[C-538] la configuration Vitest donne à chaque fragment exactement sa liste, et l'union des fragments est la liste complète", () => {
    const listes = parts.map((_, k) => {
      const r = spawnSync("npx", ["vitest", "list", "--filesOnly", "--project", "integration"], { encoding: "utf8", env: { ...process.env, SOCLE_INTEGRATION: "1", FRAGMENT_INTEGRATION: `${k + 1}/${FRAGMENTS_INTEGRATION}` } });
      expect(r.status, r.stderr).toBe(0);
      return r.stdout.split("\n").map((l) => l.trim()).filter((l) => l.endsWith(".int.test.ts")).map((l) => l.replace(/^.*?((?:apps|packages|tests|ops|scripts)\/)/, "$1")).sort();
    });
    listes.forEach((l, k) => expect(l, `fragment ${k + 1}`).toEqual([...(parts[k] ?? [])].sort()));
    expect(listes.flat().sort()).toEqual([...fichiers].sort());
  }, 120_000);
  it("[C-538] une valeur de fragment invalide fait échouer au lieu de tout lancer", () => {
    for (const v of ["0/4", "5/4", "x", "1/3", "1"]) {
      const r = spawnSync("npx", ["vitest", "list", "--filesOnly", "--project", "integration"], { encoding: "utf8", env: { ...process.env, SOCLE_INTEGRATION: "1", FRAGMENT_INTEGRATION: v } });
      expect(r.status, v).not.toBe(0);
    }
  }, 120_000);
  it("[A-066] le fichier des poids est du JSON simple avec un poids par défaut", () => {
    const brut = JSON.parse(readFileSync("ops/socle/poids-integration.json", "utf8")) as { defaut: number };
    expect(brut.defaut).toBeGreaterThan(0);
  });
});
