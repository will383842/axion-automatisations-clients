import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { contraste, valeur } from "../jetons.ts";
import { couleursDe } from "../jetons.ts";

const css = readFileSync(new URL("../responsive.css", import.meta.url), "utf8");
const media = css.slice(css.indexOf("@media (max-width: 720px)"));

describe("responsive.css", () => {
  it("[LOT0-design] responsive.css ne contient pas overflow-wrap:anywhere", () => {
    expect(css.replace(/\s+/g, "")).not.toContain("overflow-wrap:anywhere");
    expect(css).toContain("overflow-wrap: break-word");
  });

  it("[C-597] responsive.css déclare toutes les classes r-* du guide sous 720 px", () => {
    for (const c of ["r-racine", "r-menu", "r-contenu", "r-grille", "r-span", "r-ligne", "r-plein", "r-cache-mobile", "r-tableau", "r-entete", "r-onglets", "r-mobile-seul"]) {
      expect(media, c).toContain(`.${c}`);
    }
  });

  it("[C-597] sous 720 px le menu latéral est masqué (correctif du 24/10)", () => {
    expect(media).toMatch(/\.r-menu\s*\{[^}]*display:\s*none\s*!important/);
  });

  it("[C-597] r-entete fait 64 px et r-onglets est collante en bas, visibles sous 720 px", () => {
    expect(media).toMatch(/\.r-entete\s*\{[^}]*min-height:\s*64px/);
    expect(media).toMatch(/\.r-onglets\s*\{[^}]*position:\s*sticky/);
    expect(media).toMatch(/\.r-onglets\s*\{[^}]*bottom:\s*0/);
  });

  it("[C-597] aucun bouton d'action sous la barre d'onglets : marge basse dans r-contenu", () => {
    expect(media).toMatch(/\.r-contenu\s*\{[^}]*padding-bottom:/);
  });

  it("[C-597] un titre à côté d'un badge passe au-dessus (flex: 1 1 200px)", () => {
    expect(media).toContain("flex: 1 1 200px");
  });

  it("[C-597] aucune largeur minimale fixe et aucun défilement horizontal de page à 360 px", () => {
    expect(media).not.toMatch(/min-width:\s*\d{3,}px/);
    expect(media).toMatch(/\.r-racine\s*\{[^}]*overflow-x:\s*clip/);
  });

  it("[C-597] responsive.css n'utilise que des jetons : aucune couleur littérale", () => {
    expect(couleursDe(css)).toEqual([]);
  });

  it("[C-597] contrastes des couples utilisés par les composants ≥ 4,5:1", () => {
    const couples: [string, string][] = [
      ["couleur.menu.texte", "couleur.menu.fond"],
      ["couleur.menu.actif.texte", "couleur.menu.actif.fond"],
      ["couleur.menu.texte", "couleur.action"],
      ["couleur.texte.principal", "couleur.fond.carte"],
      ["couleur.actionTexte", "couleur.peche.fond"],
      ["couleur.lien", "couleur.fond.carte"],
      ["couleur.etat.urgent.texte", "couleur.etat.urgent.fond"],
      ["couleur.etat.fait.texte", "couleur.etat.fait.fond"],
    ];
    for (const [a, b] of couples) expect(contraste(valeur(a), valeur(b)), `${a}/${b}`).toBeGreaterThanOrEqual(4.5);
  });
});
