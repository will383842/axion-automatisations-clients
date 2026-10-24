import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const lire = (chemin: string) => readFileSync(fileURLToPath(new URL(`../${chemin}`, import.meta.url)), "utf8");

describe("workflows réels", () => {
  it("[C-530] securite.yml existe, se déclenche sur pull_request et push, et ses actions sont épinglées par SHA", () => {
    expect(existsSync(fileURLToPath(new URL("../.github/workflows/securite.yml", import.meta.url)))).toBe(true);
    const t = lire(".github/workflows/securite.yml");
    expect(t).toMatch(/^\s+pull_request:/m);
    expect(t).toMatch(/^\s+push:/m);
    expect(t).toContain("gitleaks/gitleaks-action@");
    const actions = [...t.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1] ?? "");
    expect(actions.length).toBe(2);
    for (const a of actions) expect(a).toMatch(/@[0-9a-f]{40}$/);
  });

  it("[C-554] SECURITY.md existe et contient un canal de contact", () => {
    const t = lire("SECURITY.md");
    expect(t).toMatch(/[\w.+-]+@[\w-]+\.[\w.-]+|https:\/\/\S+|Report a vulnerability/);
  });

  it("[C-528] ci.yml déclare les six contrôles exigés, lit seulement le dépôt, sur ubuntu-latest", () => {
    const t = lire(".github/workflows/ci.yml");
    expect(t).toMatch(/^permissions:\n\s+contents: read/m);
    for (const j of ["types", "lint", "tests", "garde-workflows", "compter-tests", "licences"]) {
      expect(t, j).toMatch(new RegExp(`^  ${j}:`, "m"));
    }
    expect(t).not.toContain("self-hosted");
    expect(t).not.toContain("pull_request_target");
  });

  it("[C-531] controle-journaux.yml suit ci.yml, sans secret ni checkout de la branche de la PR", () => {
    const t = lire(".github/workflows/controle-journaux.yml");
    expect(t).toMatch(/workflow_run:\s*\n\s+workflows:\s*\[?"?(CI|ci)/);
    expect(t).toMatch(/^permissions:\n\s+actions: write\n\s+contents: read/m);
    expect(t).not.toMatch(/secrets\.(?!GITHUB_TOKEN)/);
    expect(t).not.toMatch(/head_sha|head_branch|pull_requests/);
  });

  it("[C-531] controle-journaux.yml supprime aussi quand le téléchargement ou le scan n'a pas réussi", () => {
    const t = lire(".github/workflows/controle-journaux.yml");
    expect(t).toMatch(/id: telecharger\n(?:.*\n)*?\s+continue-on-error: true/);
    expect(t).toMatch(/if: always\(\) && \(steps\.telecharger\.outcome != 'success' \|\| steps\.scan\.outcome != 'success'\)/);
  });

  it("[C-529] chaque actions/checkout désactive persist-credentials", () => {
    for (const f of ["ci.yml", "controle-journaux.yml", "securite.yml"]) {
      const t = lire(`.github/workflows/${f}`);
      const checkouts = [...t.matchAll(/uses: actions\/checkout@/g)].length;
      const proteges = [...t.matchAll(/persist-credentials: false/g)].length;
      expect(proteges, f).toBe(checkouts);
    }
  });

  it("[C-529] dependabot.yml surveille les actions et les dépendances", () => {
    const t = lire(".github/dependabot.yml");
    expect(t).toContain("github-actions");
    expect(t).toContain("npm");
  });
});
