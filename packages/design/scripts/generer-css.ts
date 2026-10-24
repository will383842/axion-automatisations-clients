import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { aplatir, jetons } from "../src/jetons.ts";

// Génère jetons.css depuis jetons.ts : variables CSS (:root) et bloc @theme pour Tailwind 4.

type Arbre = Parameters<typeof aplatir>[0];

const nomVariable = (chemin: string) => "--" + chemin.replace(/\./g, "-");
const nomTheme = (chemin: string) => {
  const [groupe = "", ...reste] = chemin.split(".");
  const prefixe = { couleur: "color", rayon: "radius", espacement: "spacing", ombre: "shadow" }[groupe];
  return prefixe ? `--${prefixe}-${reste.join("-")}` : undefined;
};

export function genererCss(arbre: Arbre = jetons): string {
  const entrees = aplatir(arbre);
  const racine = entrees.map(([c, v]) => `  ${nomVariable(c)}: ${v};`);
  const theme = entrees.flatMap(([c]) => {
    const nom = nomTheme(c);
    return nom ? [`  ${nom}: var(${nomVariable(c)});`] : [];
  });
  return [
    "/* Fichier généré par packages/design/scripts/generer-css.ts depuis jetons.ts : ne pas modifier à la main. */",
    ":root {",
    ...racine,
    "}",
    "",
    "@theme {",
    "  --color-*: initial;",
    ...theme,
    "}",
    "",
  ].join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync(new URL("../src/jetons.css", import.meta.url), genererCss());
}
