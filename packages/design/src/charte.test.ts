import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { genererCss } from "../scripts/generer-css.ts";
import { aplatir, contraste, couleursDe, estBleu, jetons, teinte, valeur } from "./jetons.ts";

const ici = (f: string) => new URL(f, import.meta.url);
const racine = new URL("../../../", import.meta.url).pathname;

function sources(dossier: string): string[] {
  return readdirSync(dossier, { withFileTypes: true }).flatMap((e) => {
    const chemin = join(dossier, e.name);
    if (e.isDirectory()) return e.name === "node_modules" || e.name === ".next" ? [] : sources(chemin);
    return /\.(?:[cm]?[jt]sx?|css)$/.test(e.name) && !/\.test\./.test(e.name) ? [chemin] : [];
  });
}

describe("charte du lot 3", () => {
  it("[A-106] [B-246] aucun jeton ni écran de la console n'a de couleur bleue", () => {
    const fichiers = [ici("./jetons.ts").pathname, ici("./jetons.css").pathname, ...sources(join(racine, "apps/console/src"))];
    const bleus = fichiers.flatMap((f) => couleursDe(readFileSync(f, "utf8")).filter(estBleu).map((c) => `${f}: ${c}`));
    expect(bleus).toEqual([]);
    for (const [chemin, couleur] of aplatir(jetons.couleur)) expect(couleursDe(couleur).filter(estBleu), chemin).toEqual([]);
  });

  it("[B-249] aucune valeur de couleur, de taille ni d'ombre littérale dans apps/console/src", () => {
    const LITTERAL = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\(|\b\d+(?:\.\d+)?(?:px|rem|em)\b|box-shadow\s*:|shadow\s*:|fontSize\s*:\s*\d/;
    const fautes = sources(join(racine, "apps/console/src")).flatMap((f) =>
      readFileSync(f, "utf8")
        .split("\n")
        .flatMap((l, i) => (LITTERAL.test(l) ? [`${f}:${i + 1}: ${l.trim()}`] : [])),
    );
    expect(fautes).toEqual([]);
  });

  it("[B-227] [B-228] [B-233] chaque couleur nommée au registre a son jeton", () => {
    const attendus = [
      "couleur.fond.console", "couleur.fond.portail", "couleur.fond.carte", "couleur.bordure.carte", "couleur.bordure.champ",
      "couleur.texte.principal", "couleur.texte.secondaire", "couleur.texte.discret", "couleur.action", "couleur.actionTexte",
      "couleur.menu.fond", "couleur.menu.texte", "couleur.menu.secondaire", "couleur.etat.fait.fond", "couleur.etat.urgent.fond",
      "couleur.etat.averifier.fond", "couleur.sauge.fond",
    ];
    for (const chemin of attendus) expect(() => valeur(chemin), chemin).not.toThrow();
  });

  it("[B-266] chaque paire texte/fond des jetons atteint le contraste AA", () => {
    const paires: [string, string][] = [
      ["couleur.texte.discret", "couleur.fond.carte"],
      ["couleur.texte.discret", "couleur.fond.portail"],
      ["couleur.texte.discret", "couleur.fond.console"],
      ["couleur.actionTexte", "couleur.fond.carte"],
      ["couleur.actionTexte", "couleur.fond.portail"],
      ["couleur.actionTexte", "couleur.fond.console"],
      ["couleur.etat.urgent.texte", "couleur.fond.carte"],
      ["couleur.sauge.titre", "couleur.fond.carte"],
      ["couleur.menu.actif.texte", "couleur.menu.actif.fond"],
    ];
    const sous = paires.map(([t, f]) => ({ t, f, c: contraste(valeur(t), valeur(f)) })).filter((x) => x.c < 4.5);
    expect(sous).toEqual([]);
  });

  it("[B-241] le contour des champs atteint 3:1", () => {
    for (const fond of ["couleur.fond.carte", "couleur.fond.portail", "couleur.fond.console"]) {
      expect(contraste(valeur("couleur.bordure.champ"), valeur(fond)), fond).toBeGreaterThanOrEqual(3);
    }
  });

  it("[B-250] le rouge d'alerte et le terracotta sont distincts", () => {
    const ecart = (a: string, b: string) => {
      const d = Math.abs(teinte(a) - teinte(b));
      return Math.min(d, 360 - d);
    };
    // Seuil retenu par l'exécutant : 10° de teinte (le texte du registre n'est pas lisible depuis cette fiche).
    expect(ecart(valeur("couleur.etat.urgent.trait"), valeur("couleur.action"))).toBeGreaterThanOrEqual(10);
    expect(ecart(valeur("couleur.etat.urgent.trait"), valeur("couleur.menu.fond"))).toBeGreaterThanOrEqual(10);
  });

  it("[B-254] il existe exactement trois ombres", () => {
    expect(Object.keys(jetons.ombre).sort()).toEqual(["action", "carte", "menu"]);
    expect(genererCss(jetons).match(/^\s*--ombre-[\w-]+:/gm)).toHaveLength(3);
  });

  it("[B-252] [B-253] les rayons sont ceux du guide, la carte est à 22 px", () => {
    expect(jetons.rayon[22]).toBe("22px");
    expect(Object.values(jetons.rayon)).toEqual(expect.arrayContaining(["8px", "12px", "16px", "22px", "999px"]));
    expect(Object.values(jetons.espacement)).toEqual(expect.arrayContaining(["4px", "8px", "12px", "16px", "24px", "32px", "48px"]));
  });

  it("[B-248] les trois polices sont servies par le paquet", () => {
    const css = readFileSync(ici("./polices.css"), "utf8");
    expect(css).not.toMatch(/googleapis|gstatic|https?:\/\//);
    for (const p of ["manrope", "fraunces"]) expect(css).toContain(`@fontsource/${p}`);
    const inconsolata = readFileSync(ici("./polices/inconsolata.css"), "utf8");
    expect(inconsolata).toContain("Inconsolata");
    expect(inconsolata).not.toMatch(/https?:\/\//);
    for (const f of inconsolata.match(/url\("?\.\/([^")]+)"?\)/g) ?? []) {
      expect(existsSync(ici(`./polices/${f.replace(/^url\("?\.\//, "").replace(/"?\)$/, "")}`)), f).toBe(true);
    }
    expect(css).toContain("./polices/inconsolata.css");
    expect(jetons.police.code).toContain("Inconsolata");
  });

  it("[B-251] aucun texte courant sous 16 px sur téléphone, précisions à 13 px au plus bas", () => {
    expect(parseInt(jetons.taille.texteMobile)).toBeGreaterThanOrEqual(16);
    expect(parseInt(jetons.taille.precision)).toBeGreaterThanOrEqual(13);
    const mobile = readFileSync(ici("./responsive.css"), "utf8");
    expect(mobile).not.toMatch(/font-size:\s*(?:[0-9]|1[0-5])px/);
  });
});
