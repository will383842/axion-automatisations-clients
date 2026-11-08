import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";

// E1 (plan CI allégée) : plus de push sur main pour CI et Sécurité ; filet de nuit « gardes-main ». Socle intégration garde son push.

type Obj = Record<string, unknown>;
type Etape = { name?: string; run?: string; uses?: string; if?: string; with?: Obj };
type Wf = { on?: Obj; true?: Obj; jobs: Record<string, { steps: Etape[] }> };
const wf = (f: string) => load(readFileSync(fileURLToPath(new URL(`../.github/workflows/${f}`, import.meta.url)), "utf8")) as Wf;
const on = (f: string): Obj => (wf(f).on ?? wf(f).true ?? {}) as Obj;

describe("CI allégée E1", () => {
  it("[C-528] ci.yml et securite.yml ne se lancent plus sur push, socle-integration.yml garde son push sur main", () => {
    expect("push" in on("ci.yml")).toBe(false);
    expect("push" in on("securite.yml")).toBe(false);
    expect("pull_request" in on("ci.yml")).toBe(true);
    expect("pull_request" in on("securite.yml")).toBe(true);
    expect(on("socle-integration.yml").push).toEqual({ branches: ["main"] });
  });

  it("[C-528] nuit.yml porte le job gardes-main : types, lint (always), garde-workflows, garde-licences, puis Gitleaks sur tout l'historique", () => {
    const etapes = wf("nuit.yml").jobs["gardes-main"]?.steps ?? [];
    expect(etapes.length).toBeGreaterThan(0);
    const rang = (m: string) => etapes.findIndex((e) => (e.run ?? e.uses ?? "").includes(m));
    for (const m of ["pnpm -r typecheck", "pnpm lint", "node scripts/garde-workflows.ts .github/workflows", "node scripts/garde-licences.ts", "gitleaks/gitleaks-action@"]) expect(rang(m), m).toBeGreaterThanOrEqual(0);
    expect(rang("pnpm install --frozen-lockfile")).toBeLessThan(rang("pnpm -r typecheck"));
    expect(etapes[rang("pnpm lint")]?.if).toBe("always()");
    const checkout = etapes.find((e) => e.uses?.startsWith("actions/checkout@"));
    expect(checkout?.with?.["fetch-depth"]).toBe(0);
    expect(etapes[rang("gitleaks/gitleaks-action@")]?.uses).toMatch(/@ff98106e4c7b2bc287b24eaf42907196329070c7$/);
  });

  it("[C-528] nuit.yml reste sans écriture ni secret autre que GITHUB_TOKEN", () => {
    const t = readFileSync(fileURLToPath(new URL("../.github/workflows/nuit.yml", import.meta.url)), "utf8");
    expect([...t.matchAll(/secrets\.(\w+)/g)].every((m) => m[1] === "GITHUB_TOKEN")).toBe(true);
    expect(t).not.toContain("pull_request");
  });
});
