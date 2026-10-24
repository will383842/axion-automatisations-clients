import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const racine = new URL("../", import.meta.url).pathname;
const apps = ["console", "portail", "api", "executeur"].map((n) => `apps/${n}`);
const paquets = ["contrats", "design", "sdk-module", "harnais"].map((n) => `packages/${n}`);
const espaces = [...apps, ...paquets];
const interdites = /AGPL|SSPL|GPL|BUSL|fair-code/i;

describe("[LOT0-structure] squelette du monorepo", () => {
  it("chaque dossier attendu existe", () => {
    const attendus = [
      ...espaces.flatMap((e) => [`${e}/package.json`, `${e}/tsconfig.json`, `${e}/src/index.ts`, `${e}/README.md`]),
      "spec/.gitkeep",
      "scripts/.gitkeep",
      "ops/.gitkeep",
      "tests/e2e/.gitkeep",
    ];
    expect(attendus.filter((f) => !existsSync(racine + f))).toEqual([]);
  });

  it("chaque package.json est privé, UNLICENSED et nommé @axion-auto/<nom>", () => {
    for (const e of espaces) {
      const pkg = JSON.parse(readFileSync(`${racine}${e}/package.json`, "utf8"));
      expect(pkg.private, e).toBe(true);
      expect(pkg.license, e).toBe("UNLICENSED");
      expect(pkg.name, e).toBe(`@axion-auto/${e.split("/")[1]}`);
    }
  });

  it("aucune dépendance sous licence interdite", () => {
    const sortie = execSync("pnpm licenses list --json", { cwd: racine, encoding: "utf8" });
    const parLicence = JSON.parse(sortie) as Record<string, unknown>;
    const fautives = Object.keys(parLicence).filter((l) => interdites.test(l));
    expect(fautives).toEqual([]);
  });
});
