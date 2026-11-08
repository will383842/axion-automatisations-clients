import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";

// Inventaire figé des gardes lancées sur chaque pull_request (ADR 0137). Regrouper des workflows ne doit jamais retirer une garde.

type Obj = Record<string, unknown>;
type Etape = { name?: string; run?: string; uses?: string; if?: string };
const lire = (chemin: string) => readFileSync(fileURLToPath(new URL(`../${chemin}`, import.meta.url)), "utf8");
const workflow = (f: string) => load(lire(`.github/workflows/${f}`)) as { name?: string; on?: Obj; true?: Obj; concurrency?: unknown; jobs: Record<string, { name?: string; if?: string; needs?: unknown; concurrency?: unknown; steps: Etape[] }> };
const declencheurs = (f: string): Obj => {
  const w = workflow(f);
  return (w.on ?? w.true ?? {}) as Obj;
};

// Workflows qui portent les gardes sur chaque PR, et ce qu'ils doivent lancer : [fichier, job, motif cherché dans les commandes ou actions du job].
const INVENTAIRE: [string, string, string][] = [
  ["ci.yml", "types-lint", "pnpm -r typecheck"],
  ["ci.yml", "types-lint", "pnpm lint"],
  ["ci.yml", "tests", "pnpm test:compter"],
  ["ci.yml", "tests", "node scripts/compter-tests.ts rapport-tests.json"],
  ["ci.yml", "garde-workflows", "node scripts/garde-workflows.ts .github/workflows"],
  ["ci.yml", "licences", "node scripts/garde-licences.ts"],
  ["ci.yml", "harnais", "pnpm test --project packages/harnais"],
  ["ci.yml", "squelettes-web", "/api/sante"],
  ["garde-briques.yml", "garde-briques", "node scripts/garde-donnees-reelles.ts"],
  ["garde-briques.yml", "garde-briques", "node scripts/garde-briques.ts"],
  ["garde-briques.yml", "garde-briques", "gh attestation verify"],
  ["garde-briques.yml", "garde-briques", "node scripts/garde-couleurs.ts"],
  ["garde-briques.yml", "garde-briques", "node scripts/garde-migrations.ts"],
  ["audit-dependances.yml", "audit-dependances", "node scripts/audit-dependances.ts"],
  ["securite.yml", "secrets", "gitleaks/gitleaks-action@"],
];

const texteJob = (f: string, j: string): string => (workflow(f).jobs[j]?.steps ?? []).map((e) => `${e.run ?? ""}\n${e.uses ?? ""}`).join("\n");

describe("inventaire des gardes sur chaque pull_request", () => {
  it("[C-528] chaque garde de l'inventaire figé est toujours lancée (l'inventaire d'après couvre celui d'avant)", () => {
    const manquantes = INVENTAIRE.filter(([f, j, motif]) => !texteJob(f, j).includes(motif)).map(([f, j, motif]) => `${f} / ${j} : ${motif}`);
    expect(manquantes).toEqual([]);
  });

  it("[C-528] aucun workflow de l'inventaire ne filtre la pull_request (ni paths, ni paths-ignore, ni branches, ni types hors défaut)", () => {
    for (const f of new Set(INVENTAIRE.map(([w]) => w))) {
      const on = declencheurs(f);
      expect("pull_request" in on, f).toBe(true);
      const pr = on.pull_request;
      expect(pr === null || pr === undefined || Object.keys(pr as Obj).length === 0, f).toBe(true);
    }
  });

  it("[C-528] les gardes regroupées ne sont plus des workflows à part, et les gardes suivantes tournent même si une autre échoue", () => {
    const etapes = workflow("garde-briques.yml").jobs["garde-briques"]?.steps ?? [];
    const rang = (motif: string) => etapes.findIndex((e) => e.run?.includes(motif));
    expect(rang("garde-donnees-reelles.ts")).toBeLessThan(rang("pnpm install --frozen-lockfile"));
    for (const motif of ["garde-couleurs.ts", "garde-migrations.ts"]) expect(etapes[rang(motif)]?.if, motif).toBe("always()");
    expect(etapes[rang("pnpm install --frozen-lockfile")]?.if).toBeUndefined();
    expect(etapes[rang("pnpm lint")]).toBeUndefined();
    const ci = workflow("ci.yml").jobs;
    expect(ci["types-lint"]?.steps.find((e) => e.run === "pnpm lint")?.if).toBe("always()");
  });

  it("[C-528] les cinq contrôles exigés par main existent sans condition, sauf l'agrégateur socle (if: always())", () => {
    const exiges: [string, string][] = [["securite.yml", "secrets"], ["ci.yml", "tests"], ["ci.yml", "licences"], ["ci.yml", "garde-workflows"]];
    for (const [f, j] of exiges) {
      const job = workflow(f).jobs[j];
      expect(job, `${f} / ${j}`).toBeDefined();
      expect(job?.if, `${f} / ${j} : aucune condition`).toBeUndefined();
      for (const e of job?.steps ?? []) expect(e.if, `${f} / ${j} : étape ${e.name ?? e.run ?? e.uses}`).toBeUndefined();
    }
    const socle = workflow("socle-integration.yml").jobs["socle-integration"];
    expect(socle?.if).toBe("always()");
    expect(socle?.needs).toEqual(["fragment-1", "fragment-2", "fragment-3", "fragment-4"]);
    expect(texteJob("socle-integration.yml", "socle-integration")).toContain('test "$RESULTATS_FRAGMENTS" = "success success success success"');
  });

  it("[C-530] le nom du job Gitleaks est exactement celui exigé par main", () => {
    expect(workflow("securite.yml").jobs["secrets"]?.name).toBe("Aucun secret dans le dépôt (Gitleaks)");
  });

  it("[C-531] chaque workflow du dépôt figure dans la liste de controle-journaux (aucun journal public sans contrôle)", () => {
    const liste = ((workflow("controle-journaux.yml").on ?? workflow("controle-journaux.yml").true) as { workflow_run: { workflows: string[] } }).workflow_run.workflows;
    const fichiers = readdirSync(fileURLToPath(new URL("../.github/workflows", import.meta.url))).filter((f) => /\.ya?ml$/.test(f) && f !== "controle-journaux.yml");
    const absents = fichiers.map((f) => workflow(f).name ?? f).filter((nom) => !liste.includes(nom));
    expect(absents).toEqual([]);
  });

  it("[C-531] controle-journaux ne saute que les runs sautés : ni concurrency, ni autre condition que ce filtre", () => {
    const w = workflow("controle-journaux.yml");
    const job = w.jobs["controle-journaux"];
    expect(w.concurrency).toBeUndefined();
    expect(job?.concurrency).toBeUndefined();
    expect(job?.if).toBe("github.event.workflow_run.conclusion != 'skipped'");
    const avecCondition = (job?.steps ?? []).filter((e) => e.if !== undefined).map((e) => e.name ?? e.run ?? e.uses);
    expect(avecCondition).toHaveLength(2);
  });

  it("[C-531] l'étape de suppression garde sa condition : suppression si le téléchargement ou le scan n'a pas réussi", () => {
    const etapes = workflow("controle-journaux.yml").jobs["controle-journaux"]?.steps ?? [];
    const suppression = etapes.find((e) => e.name?.startsWith("Supprimer"));
    expect(suppression?.if).toBe("always() && (steps.telecharger.outcome != 'success' || steps.scan.outcome != 'success')");
  });
});
