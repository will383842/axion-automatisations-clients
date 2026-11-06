import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { Ecran } from "../apps/console/src/ecrans.ts";

// Garde des écrans (T3-04) : toute page de la console doit être inscrite au registre, et toute ligne du registre doit avoir sa page.

/** Pages (page.tsx) sous le dossier, chemins relatifs à src/app/, séparés par « / ». */
export function pagesDe(dossier: string): string[] {
  const parcourir = (d: string): string[] =>
    readdirSync(d, { withFileTypes: true }).flatMap((e) => {
      const chemin = join(d, e.name);
      if (e.isDirectory()) return e.name === "node_modules" ? [] : parcourir(chemin);
      return e.name === "page.tsx" ? [relative(dossier, chemin).split("\\").join("/")] : [];
    });
  return parcourir(dossier).sort();
}

/** Adresse d'une page : groupes « (x) » retirés, « page.tsx » retiré. */
export const routeDe = (page: string): string => {
  const morceaux = page.split("/").slice(0, -1).filter((m) => !/^\(.*\)$/.test(m));
  return `/${morceaux.join("/")}`;
};

export function verifierEcrans(dossier: string, ecrans: readonly Ecran[]): string[] {
  const pages = pagesDe(dossier);
  const inscrites = new Set(ecrans.map((e) => e.page));
  return [
    ...pages.filter((p) => !inscrites.has(p)).map((p) => `${p} : page non inscrite au registre apps/console/src/ecrans.ts`),
    ...ecrans.filter((e) => !pages.includes(e.page)).map((e) => `${e.page} : ligne du registre sans page`),
    ...ecrans.filter((e) => e.route !== routeDe(e.page)).map((e) => `${e.page} : la route ${e.route} devrait être ${routeDe(e.page)}`),
  ];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { ECRANS } = await import("../apps/console/src/ecrans.ts");
  const erreurs = verifierEcrans(fileURLToPath(new URL("../apps/console/src/app", import.meta.url)), ECRANS);
  erreurs.forEach((e) => console.error(e));
  if (erreurs.length) process.exit(1);
  console.log("garde-ecrans : toutes les pages sont inscrites");
}
