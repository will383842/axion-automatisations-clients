import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { construire } from "./construire.ts";

const EXEMPLE = fileURLToPath(new URL("../../exemples/module-exemple.ts", import.meta.url));
const racines: string[] = [];
afterAll(() => racines.forEach((r) => rmSync(r, { recursive: true, force: true })));

interface Dep {
  dossier?: string;
  nom?: string;
  licence?: string;
}
// Projet jetable : un module qui réexporte l'exemple, plus des dépendances inventées dans node_modules.
function projet(opts: { deps?: Dep[]; inutilises?: Dep[]; extra?: string; source?: string } = {}): string {
  const racine = mkdtempSync(join(tmpdir(), "emballage-"));
  racines.push(racine);
  const toutes = [...(opts.deps ?? []), ...(opts.inutilises ?? [])];
  for (const d of toutes) {
    const dir = join(racine, "node_modules", d.dossier ?? d.nom ?? "x");
    mkdirSync(dir, { recursive: true });
    const pkg: Record<string, unknown> = { name: d.nom ?? d.dossier, version: "1.2.3" };
    if (d.licence !== undefined) pkg.license = d.licence;
    writeFileSync(join(dir, "package.json"), JSON.stringify(pkg));
    writeFileSync(join(dir, "index.js"), "export default 1;\n");
  }
  const imports = (opts.deps ?? []).map((d, i) => `import d${i} from ${JSON.stringify(d.dossier ?? d.nom)};\nexport const u${i} = d${i};`).join("\n");
  const source = opts.source ?? `import { moduleExemple } from ${JSON.stringify(EXEMPLE)};\nexport default moduleExemple;\n`;
  writeFileSync(join(racine, "module.ts"), `${source}\n${imports}\n${opts.extra ?? ""}\n`);
  return join(racine, "module.ts");
}
const MIT = { licence: "MIT" };

describe("construire un module", () => {
  it("[A-302] deux constructions du module d'exemple ont la même empreinte", async () => {
    const m = projet();
    const a = await construire(m, join(dirname(m), "sortie-a"));
    const b = await construire(m, join(dirname(m), "sortie-b"));
    expect(a.empreinte).toBe(b.empreinte);
    for (const f of ["module.js", "manifest.json", "sbom.cdx.json", "empreinte.sha256"]) {
      expect(readFileSync(join(a.dossier, f))).toEqual(readFileSync(join(b.dossier, f)));
    }
    expect(readdirSync(a.dossier).sort()).toEqual(["empreinte.sha256", "manifest.json", "module.js", "sbom.cdx.json"]);
  });

  it("[A-302] le manifeste n'a ni fonction ni jeu d'essai, et porte le schéma des réglages", async () => {
    const m = projet();
    const { dossier } = await construire(m);
    const man = JSON.parse(readFileSync(join(dossier, "manifest.json"), "utf8")) as Record<string, unknown>;
    expect(man.code).toBe("accuse-reception");
    expect(man.schemaReglages).toBeTypeOf("object");
    expect(man).not.toHaveProperty("migrer");
    expect(man).not.toHaveProperty("jeuEssai");
  });

  it("[A-302] aucun chemin de la machine n'entre dans module.js", async () => {
    const m = projet({ deps: [{ nom: "petit", ...MIT }] });
    const { dossier } = await construire(m);
    const js = readFileSync(join(dossier, "module.js"), "utf8");
    expect(js).not.toContain(dirname(m));
    expect(js).not.toContain(tmpdir());
    expect(js).not.toContain(process.cwd());
  });

  it("[A-302] l'empreinte couvre module.js, manifest.json, sbom.cdx.json dans cet ordre", async () => {
    const m = projet();
    const { dossier, empreinte } = await construire(m);
    const { createHash } = await import("node:crypto");
    const lire = (f: string) => readFileSync(join(dossier, f));
    const h = createHash("sha256").update(lire("module.js")).update("\n").update(lire("manifest.json")).update("\n").update(lire("sbom.cdx.json")).digest("hex");
    expect(empreinte).toBe(h);
    expect(readFileSync(join(dossier, "empreinte.sha256"), "utf8")).toBe(`${h}\n`);
  });

  it("[A-017] le SBOM liste chaque dépendance emballée avec sa licence, et seulement elles", async () => {
    const m = projet({ deps: [{ nom: "petit", ...MIT }, { nom: "@lot/grand", licence: "Apache-2.0" }], inutilises: [{ nom: "outil-de-dev", ...MIT }] });
    const { dossier } = await construire(m);
    const sbom = JSON.parse(readFileSync(join(dossier, "sbom.cdx.json"), "utf8")) as { bomFormat: string; specVersion: string; components: { name: string; version: string; licenses: { expression: string }[] }[] };
    expect([sbom.bomFormat, sbom.specVersion]).toEqual(["CycloneDX", "1.6"]);
    const noms = sbom.components.map((c) => c.name);
    expect(noms).toContain("petit");
    expect(noms).toContain("@lot/grand");
    expect(noms).toContain("zod");
    expect(noms).not.toContain("outil-de-dev");
    expect(sbom.components.find((c) => c.name === "@lot/grand")?.licenses[0]?.expression).toBe("Apache-2.0");
    expect(sbom.components.every((c) => c.version && c.licenses.length === 1)).toBe(true);
  });

  it("[C-471] une dépendance AGPL est refusée", async () => {
    const m = projet({ deps: [{ nom: "copyleft", licence: "AGPL-3.0-only" }] });
    await expect(construire(m)).rejects.toThrow(/copyleft.*licence/);
  });

  it("[C-471] une licence « non commerciale » est refusée", async () => {
    const m = projet({ deps: [{ nom: "payant", licence: "CC-BY-NC-4.0" }] });
    await expect(construire(m)).rejects.toThrow(/payant.*licence/);
  });

  it("[C-471] une licence absente est refusée", async () => {
    const m = projet({ deps: [{ nom: "muet" }] });
    await expect(construire(m)).rejects.toThrow(/muet.*licence/);
  });

  it("[C-492] une dépendance n8n est refusée", async () => {
    const m = projet({ deps: [{ nom: "n8n-workflow", ...MIT }] });
    await expect(construire(m)).rejects.toThrow(/n8n-workflow.*provenance/);
  });

  it("[C-492] un dossier au nom innocent mais un package.json au nom différent est refusé", async () => {
    const m = projet({ deps: [{ dossier: "n8n-core", nom: "innocent", ...MIT }] });
    await expect(construire(m)).rejects.toThrow(/n8n-core.*nom/);
  });

  it("[A-283] un module sans defineAutomation n'est pas emballé", async () => {
    const m = projet({ source: `export default { code: "faux", paquet: "@axion-auto/faux", schemaReglages: {} };` });
    await expect(construire(m)).rejects.toThrow(/defineAutomation/);
  });

  it("[A-302] une clé en dur dans le module est refusée et le message ne la contient pas", async () => {
    const cle = "AKIA" + "IOSFODNN7EXAMPLE";
    const m = projet({ extra: `export const cle = "${cle}";` });
    const erreur = await construire(m).then(() => "", (e: Error) => e.message);
    expect(erreur).toMatch(/clé/);
    expect(erreur).not.toContain(cle);
  });

  it("[A-302] un lien symbolique à la place d'un fichier de sortie n'est pas suivi", async () => {
    const m = projet();
    const sortie = join(dirname(m), "sortie");
    mkdirSync(sortie);
    const cible = join(dirname(m), "cible.txt");
    writeFileSync(cible, "intact");
    symlinkSync(cible, join(sortie, "module.js"));
    await construire(m, sortie);
    expect(readFileSync(cible, "utf8")).toBe("intact");
    expect(existsSync(join(sortie, "module.js"))).toBe(true);
    expect(readFileSync(join(sortie, "module.js"), "utf8")).toContain("accuse-reception");
  });
});
