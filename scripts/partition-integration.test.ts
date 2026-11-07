import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FRAGMENTS_INTEGRATION, charge, fichiersIntegration, lirePoids, partitionner, poidsDe } from "./partition-integration.ts";

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
  it("[A-066] la charge estimée est équilibrée : le fragment le plus long ne dépasse ni le fichier le plus lourd + 5 % ni la moyenne + 10 %", () => {
    const charges = parts.map((p) => charge(p, poids));
    const moyenne = charge(fichiers, poids) / parts.length;
    const lourd = Math.max(...fichiers.map((f) => poidsDe(f, poids)));
    // Un fichier seul ne se partage pas : il fixe alors la durée du fragment (à découper dans une autre tâche).
    expect(Math.max(...charges)).toBeLessThanOrEqual(Math.max(lourd * 1.05, moyenne * 1.1));
    // Les fragments sans le fichier le plus lourd restent proches les uns des autres (écart d'au plus 90 s).
    const sansLourd = parts.filter((p) => !p.some((f) => poidsDe(f, poids) === lourd)).map((p) => charge(p, poids));
    expect(Math.max(...sansLourd) - Math.min(...sansLourd)).toBeLessThanOrEqual(90);
  });
  it("[A-066] les fichiers qui créent des bases depuis modele_v1 sont dans des fragments différents (course « accessed by other users »)", () => {
    const [groupe] = poids.separes ?? [];
    expect(groupe?.length).toBeGreaterThanOrEqual(4);
    for (const f of groupe ?? []) expect(fichiers, f).toContain(f);
    const fragmentDe = (f: string) => parts.findIndex((p) => p.includes(f));
    // Les trois fichiers qui font CREATE DATABASE … TEMPLATE modele_v1 ne se rencontrent jamais ; le 4e (connexions de contrôle) évite au moins vagues.
    const createurs = (groupe ?? []).slice(0, 3).map(fragmentDe);
    expect(new Set(createurs).size).toBe(Math.min(3, parts.length));
    expect(fragmentDe((groupe ?? [])[3] ?? "")).not.toBe(fragmentDe((groupe ?? [])[1] ?? ""));
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
    for (const v of ["0/3", "4/3", "x", "1/4", "1"]) {
      const r = spawnSync("npx", ["vitest", "list", "--filesOnly", "--project", "integration"], { encoding: "utf8", env: { ...process.env, SOCLE_INTEGRATION: "1", FRAGMENT_INTEGRATION: v } });
      expect(r.status, v).not.toBe(0);
    }
  }, 120_000);
  it("[A-066] le fichier des poids est du JSON simple avec un poids par défaut", () => {
    const brut = JSON.parse(readFileSync("ops/socle/poids-integration.json", "utf8")) as { defaut: number };
    expect(brut.defaut).toBeGreaterThan(0);
  });
});
