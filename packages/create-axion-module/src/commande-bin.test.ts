import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Ce fichier modifie le dépôt (modules/, node_modules, pnpm-lock.yaml) : le projet Vitest « serie » le lance seul, après les autres.
const pnpm = (args: string[], cwd: string) => spawnSync("pnpm", args, { cwd, encoding: "utf8" });

const depot = fileURLToPath(new URL("../../../", import.meta.url));
const tsx = join(depot, "node_modules", ".bin", "tsx");

const commandeDuScript = (): string[] => {
  const script = (JSON.parse(readFileSync(join(depot, "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts["creer-module"] ?? "";
  const [programme, ...arguments_] = script.split(" ");
  expect(programme).toBe("tsx");
  return arguments_.map((a) => join(depot, a));
};

describe("lignes de commande réelles qui modifient le dépôt", () => {
  // Passe par le vrai lien du bin (node_modules/.bin), comme « pnpm test:module » dans un module créé par le modèle.
  it("[A-401] « axion-dev » lancé par le bin lance vraiment les tests, et un test qui échoue donne un code non nul", () => {
    const verrou = join(depot, "pnpm-lock.yaml");
    const verrouAvant = readFileSync(verrou, "utf8");
    const dossier = join(depot, "modules", "essai-bin-axion-dev");
    try {
      expect(spawnSync(tsx, [...commandeDuScript(), "essai-bin-axion-dev"], { cwd: depot, encoding: "utf8" }).status).toBe(0);
      const installation = pnpm(["install", "--prefer-offline", "--no-frozen-lockfile"], depot);
      expect(installation.status, installation.stderr).toBe(0);

      const reussi = pnpm(["exec", "axion-dev", "test"], dossier);
      expect(reussi.stdout).toMatch(/tests réussis/);
      expect(reussi.status).toBe(0);

      const inconnue = pnpm(["exec", "axion-dev", "nimportequoi"], dossier);
      expect(inconnue.stdout).toContain("usage : axion-dev");
      expect(inconnue.status).toBe(1);

      const fichierModule = join(dossier, "src", "module.ts");
      writeFileSync(fichierModule, readFileSync(fichierModule, "utf8").replace("executer: async () => undefined", 'executer: async () => { throw new Error("cas voulu en échec"); }'));
      const echoue = pnpm(["exec", "axion-dev", "test"], dossier);
      expect(echoue.stdout).toMatch(/échoués/);
      expect(echoue.status).not.toBe(0);
    } finally {
      rmSync(dossier, { recursive: true, force: true });
      writeFileSync(verrou, verrouAvant);
      pnpm(["install", "--prefer-offline", "--frozen-lockfile"], depot);
    }
  }, 240_000);
});
