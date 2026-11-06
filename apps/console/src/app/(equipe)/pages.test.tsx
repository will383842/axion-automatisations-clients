import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { COMPTE, ENTREES } from "../../lib/navigation.ts";

describe("écrans vides de la coquille", () => {
  it("[A-003] chaque entrée du menu, le compte et « Plus » ont une page vide qui s'affiche", async () => {
    const dossiers = readdirSync(fileURLToPath(new URL(".", import.meta.url)), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    for (const e of [...ENTREES, COMPTE]) {
      const nom = e.href.slice(1);
      expect(dossiers, nom).toContain(nom);
      const { default: Page } = await import(`./${nom}/page.tsx`);
      expect(renderToStaticMarkup(<Page />), nom).toContain(`<h1 id="titre">${e.libelle}</h1>`);
    }
    expect(dossiers).toContain("plus");
  });
});
