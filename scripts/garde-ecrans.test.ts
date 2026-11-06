import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ECRANS } from "../apps/console/src/ecrans.ts";
import { pagesDe, verifierEcrans } from "./garde-ecrans.ts";

const ARBRE = fileURL();
function fileURL(): string {
  return new URL("../apps/console/src/app", import.meta.url).pathname;
}

function faux(pages: string[]): string {
  const racine = mkdtempSync(join(tmpdir(), "ecrans-"));
  for (const p of pages) {
    mkdirSync(join(racine, p, ".."), { recursive: true });
    writeFileSync(join(racine, p), "export default function Page() { return null; }\n");
  }
  return racine;
}

describe("garde-ecrans", () => {
  it("[LOT3-ecrans] la garde échoue pour une page non inscrite", () => {
    const racine = faux(["(equipe)/clients/page.tsx", "(equipe)/nouveau/page.tsx"]);
    const erreurs = verifierEcrans(racine, [{ route: "/clients", page: "(equipe)/clients/page.tsx", maquette: null, etats: ["normal"] }]);
    expect(erreurs).toHaveLength(1);
    expect(erreurs[0]).toContain("(equipe)/nouveau/page.tsx");
  });

  it("[LOT3-ecrans] la garde échoue pour une ligne du registre sans page", () => {
    const racine = faux(["(equipe)/clients/page.tsx"]);
    const erreurs = verifierEcrans(racine, [
      { route: "/clients", page: "(equipe)/clients/page.tsx", maquette: null, etats: ["normal"] },
      { route: "/fantome", page: "fantome/page.tsx", maquette: null, etats: ["normal"] },
    ]);
    expect(erreurs.join("\n")).toContain("fantome/page.tsx");
  });

  it("[LOT3-ecrans] les pages réelles de la console sont toutes inscrites au registre", () => {
    expect(pagesDe(ARBRE).length).toBeGreaterThan(0);
    expect(verifierEcrans(ARBRE, ECRANS)).toEqual([]);
  });
});
