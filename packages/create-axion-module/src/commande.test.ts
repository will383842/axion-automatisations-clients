import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const pnpm = (args: string[], cwd: string) => spawnSync("pnpm", args, { cwd, encoding: "utf8" });

const depot = fileURLToPath(new URL("../../../", import.meta.url));
const tsx = join(depot, "node_modules", ".bin", "tsx");
const dossierEssai = mkdtempSync(join(tmpdir(), "creer-module-"));
afterAll(() => rmSync(dossierEssai, { recursive: true, force: true }));

// La commande exacte du script racine, lancée comme le fait « pnpm creer-module » (Node sans transformation TypeScript : plantage).
const commandeDuScript = (): string[] => {
  const script = (JSON.parse(readFileSync(join(depot, "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts["creer-module"] ?? "";
  const [programme, ...arguments_] = script.split(" ");
  expect(programme).toBe("tsx");
  return arguments_.map((a) => join(depot, a));
};

describe("lignes de commande réelles", () => {
  it("[C-242] « creer-module » s'exécute pour de vrai, sort en 0 et crée le module", () => {
    const r = spawnSync(tsx, [...commandeDuScript(), "relance-devis"], { cwd: dossierEssai, encoding: "utf8" });
    expect(r.stderr).not.toContain("ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX");
    expect(r.status).toBe(0);
    expect(existsSync(join(dossierEssai, "modules", "relance-devis", "package.json"))).toBe(true);
  });

  it("[C-242] le bin « axion-dev » démarre pour de vrai et affiche son usage", () => {
    const r = spawnSync(tsx, [join(depot, "packages/axion-dev/src/index.ts")], { cwd: dossierEssai, encoding: "utf8" });
    expect(r.stderr).not.toContain("ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX");
    expect(r.stdout).toContain("usage : axion-dev");
    expect(r.status).toBe(1);
  });

  it("[C-242] le modèle de module dépend d'axion-dev et expose « test:module »", () => {
    const modele = JSON.parse(readFileSync(join(depot, "packages/create-axion-module/gabarit/package.json.modele"), "utf8")) as {
      scripts: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    const dev = JSON.parse(readFileSync(join(depot, "packages/axion-dev/package.json"), "utf8")) as { name: string; bin: Record<string, string> };
    expect(modele.devDependencies[dev.name]).toBe("workspace:*");
    expect(Object.keys(dev.bin)).toContain("axion-dev");
    expect(modele.scripts["test:module"]).toBe("axion-dev test");
  });
});
