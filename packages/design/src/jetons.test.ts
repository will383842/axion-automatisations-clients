import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { genererCss } from "../scripts/generer-css.ts";
import { contraste, couleursDe, couplesContraste, estBleu, jetons, valeur } from "./jetons.ts";

const ici = (f: string) => new URL(f, import.meta.url);

describe("jetons", () => {
  it("[C-597] jetons.ts ne contient aucun bleu", () => {
    const bleus = couleursDe(readFileSync(ici("./jetons.ts"), "utf8")).filter(estBleu);
    expect(bleus).toEqual([]);
    expect(estBleu("#1a4dd9")).toBe(true);
    expect(estBleu("#9a3812")).toBe(false);
  });

  it("[C-595] jetons.css est identique à sa génération", () => {
    expect(readFileSync(ici("./jetons.css"), "utf8")).toBe(genererCss(jetons));
  });

  it("[C-595] jetons.css porte le bloc @theme et les variables", () => {
    const css = genererCss(jetons);
    expect(css).toContain("@theme {");
    expect(css).toContain("--couleur-action: #c24a1b;");
  });

  it("[C-597] contraste texte/fond ≥ 4,5 pour chaque couple texte-fond déclaré", () => {
    expect(couplesContraste.length).toBeGreaterThan(10);
    const sous = couplesContraste
      .map(([t, f]) => ({ t, f, c: contraste(valeur(t), valeur(f)) }))
      .filter((x) => x.c < 4.5);
    expect(sous).toEqual([]);
  });

  it("[C-586] les teintes du guide « blocs colorés » sont présentes", () => {
    expect(valeur("couleur.teinte.terracotta.fond")).toBe("#fbe3d6");
    expect(valeur("couleur.teinte.vert.liseret")).toBe("#1f6b4a");
    expect(valeur("couleur.teinte.gris.titre")).toBe("#2f2a24");
    expect(valeur("couleur.menu.fond")).toBe("#9a3812");
  });

  it("[LOT0-design] les polices sont servies depuis le paquet, aucune URL fonts.googleapis.com", () => {
    const css = readFileSync(ici("./polices.css"), "utf8");
    expect(css).not.toMatch(/googleapis|gstatic|https?:\/\//);
    expect(css).toContain("@fontsource/manrope");
    expect(css).toContain("@fontsource/fraunces");
    const pkg = JSON.parse(readFileSync(ici("../package.json"), "utf8")) as { dependencies: Record<string, string> };
    expect(Object.keys(pkg.dependencies)).toEqual(expect.arrayContaining(["@fontsource/manrope", "@fontsource/fraunces"]));
  });

  it("[C-597] couleursDe lit les formes à 3, 4 et 8 chiffres et hsl(, estBleu les juge", () => {
    expect(couleursDe("#00f #1a4dd9ff #abcd hsl(220 80% 50%)")).toHaveLength(4);
    expect(couleursDe("#00f #1a4dd9ff hsl(220 80% 50%) hsla(220, 80%, 50%, 0.5)").filter(estBleu)).toHaveLength(4);
    expect(estBleu("hsl(20 80% 50%)")).toBe(false);
  });

  it("[C-586] les couleurs d'illustration viennent des maquettes", () => {
    expect(Object.values(jetons.couleur.illustration)).toEqual(
      expect.arrayContaining(["#f6c3a8", "#a9cfbb", "#7fb59a", "#9cc8b0", "#cfe5d8"]),
    );
  });

  it("[C-595] jetons.css remet à zéro la palette par défaut de Tailwind", () => {
    expect(genererCss(jetons)).toContain("--color-*: initial;");
  });
});
