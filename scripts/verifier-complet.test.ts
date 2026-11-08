import { describe, expect, it } from "vitest";
import { etapes, lancer } from "./verifier-complet.ts";

describe("verifier-complet", () => {
  it("lance pnpm verifier d'abord, puis compter-tests, licences et garde-workflows", () => {
    const noms = etapes().map((e) => e.nom);
    expect(noms).toEqual(["verifier", "tests-rapport", "compter-tests", "licences", "garde-workflows"]);
  });
  it("garde les commandes de la CI, sans les affaiblir", () => {
    const cmds = etapes().map((e) => [e.commande, ...e.args].join(" "));
    expect(cmds).toContain("pnpm verifier");
    expect(cmds).toContain("pnpm test:compter");
    expect(cmds).toContain("node scripts/compter-tests.ts --rapport rapport-tests.json --base-ref origin/main");
    expect(cmds).toContain("node scripts/garde-licences.ts");
    expect(cmds).toContain("node scripts/garde-workflows.ts .github/workflows");
  });
  it("s'arrête à la première étape en échec et rend son code", () => {
    const vues: string[] = [];
    const code = lancer(etapes(), (e) => {
      vues.push(e.nom);
      return e.nom === "compter-tests" ? 3 : 0;
    });
    expect(code).toBe(3);
    expect(vues).toEqual(["verifier", "tests-rapport", "compter-tests"]);
  });
  it("rend 0 quand tout passe", () => {
    expect(lancer(etapes(), () => 0)).toBe(0);
  });
});
