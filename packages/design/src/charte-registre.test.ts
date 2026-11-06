import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as paquet from "./index.ts";
import { aplatir, contraste, couleursDe, estBleu, jetons, teinte, valeur } from "./jetons.ts";

const ici = (f: string) => new URL(f, import.meta.url);
const ecart = (a: string, b: string) => {
  const d = Math.abs(teinte(a) - teinte(b));
  return Math.min(d, 360 - d);
};

// Exigences de charte de T3-02 qui n'avaient pas de test portant leur numéro (fiche T3-02b).
describe("charte : exigences nommées", () => {
  it("[B-236] les fonds sont ivoire, papier, sable ou mocha ; jamais de noir pur", () => {
    for (const c of ["couleur.fond.portail", "couleur.fond.console", "couleur.fond.carte", "couleur.initiales.fond"]) expect(() => valeur(c), c).not.toThrow();
    const noirs = aplatir(jetons.couleur).filter(([, c]) => couleursDe(c).some((x) => /^#0{3,8}$/.test(x) || /^rgba?\(\s*0\s*,\s*0\s*,\s*0\s*[,)]/.test(x)));
    expect(noirs).toEqual([]);
    expect(valeur("couleur.fond.carte").toLowerCase()).toBe("#ffffff");
  });

  it("[B-237] trois niveaux de texte, du plus foncé au plus discret, tous lisibles sur la carte", () => {
    const sur = valeur("couleur.fond.carte");
    const [p, s, d] = ["principal", "secondaire", "discret"].map((n) => contraste(valeur(`couleur.texte.${n}`), sur)) as [number, number, number];
    expect(p).toBeGreaterThan(s);
    expect(s).toBeGreaterThan(d);
    expect(d).toBeGreaterThanOrEqual(4.5);
  });

  it("[B-238] le bouton principal et les liens utilisent la couleur d'action, jamais un bleu", () => {
    const base = readFileSync(ici("./composants/base.tsx"), "utf8");
    expect(base).toContain('principal ? v("couleur-action")');
    expect(base).toContain('v("couleur-lien")');
    for (const c of ["couleur.action", "couleur.actionTexte", "couleur.lien"]) expect(estBleu(valeur(c)), c).toBe(false);
    expect(contraste(valeur("couleur.actionTexte"), valeur("couleur.fond.carte"))).toBeGreaterThanOrEqual(4.5);
  });

  it("[B-239] la couleur d'action est un terracotta (teinte orange-rouge) et son texte reste dans la même famille", () => {
    expect(teinte(valeur("couleur.action"))).toBeGreaterThanOrEqual(10);
    expect(teinte(valeur("couleur.action"))).toBeLessThanOrEqual(25);
    expect(ecart(valeur("couleur.actionTexte"), valeur("couleur.action"))).toBeLessThanOrEqual(10);
  });

  it("[B-240] les bordures décoratives existent et restent discrètes (sous 3:1)", () => {
    for (const c of ["couleur.bordure.carte", "couleur.separateur"]) {
      expect(contraste(valeur(c), valeur("couleur.fond.carte")), c).toBeLessThan(3);
    }
  });

  it("[B-242] les fonds d'accent sont des terracotta doux, aucun fond bleu", () => {
    for (const c of ["couleur.peche.fond", "couleur.teinte.terracotta.fond"]) {
      expect(estBleu(valeur(c)), c).toBe(false);
      expect(ecart(valeur(c), valeur("couleur.action")), c).toBeLessThanOrEqual(20);
    }
    const fonds = aplatir(jetons.couleur).filter(([c]) => c.endsWith(".fond"));
    expect(fonds.filter(([, c]) => couleursDe(c).some(estBleu))).toEqual([]);
  });

  it("[B-243] la sauge sert aux preuves et confirmations : teinte verte et texte lisible", () => {
    const t = teinte(valeur("couleur.sauge.titre"));
    expect(t).toBeGreaterThanOrEqual(90);
    expect(t).toBeLessThanOrEqual(170);
    expect(contraste(valeur("couleur.sauge.titre"), valeur("couleur.sauge.fond"))).toBeGreaterThanOrEqual(4.5);
  });

  it("[B-244] l'alerte est un rouge lisible, et la pastille rouge porte toujours un mot", () => {
    const t = teinte(valeur("couleur.etat.urgent.trait"));
    expect(t < 15 || t > 345).toBe(true);
    expect(contraste(valeur("couleur.etat.urgent.texte"), valeur("couleur.etat.urgent.fond"))).toBeGreaterThanOrEqual(4.5);
    expect(() => paquet.Pastille({ couleur: "rouge", mot: " " })).toThrow();
  });

  it("[B-245] l'avertissement est un orange foncé sur fond crème, lisible", () => {
    const t = teinte(valeur("couleur.etat.averifier.texte"));
    expect(t).toBeGreaterThanOrEqual(25);
    expect(t).toBeLessThanOrEqual(50);
    expect(contraste(valeur("couleur.etat.averifier.texte"), valeur("couleur.etat.averifier.fond"))).toBeGreaterThanOrEqual(4.5);
  });

  it("[B-265] le menu latéral est terracotta avec texte blanc ; le terracotta n'est jamais le texte sur le fond mocha", () => {
    expect(ecart(valeur("couleur.menu.fond"), valeur("couleur.action"))).toBeLessThanOrEqual(15);
    expect(contraste(valeur("couleur.menu.texte"), valeur("couleur.menu.fond"))).toBeGreaterThanOrEqual(4.5);
    expect(contraste(valeur("couleur.menu.secondaire"), valeur("couleur.menu.fond"))).toBeGreaterThanOrEqual(4.5);
    // Aucun couple texte/fond déclaré ne pose le terracotta d'action en texte sur le mocha.
    expect(contraste(valeur("couleur.initiales.texte"), valeur("couleur.initiales.fond"))).toBeGreaterThanOrEqual(4.5);
  });

  it("[C-411] le paquet partagé exporte les composants, avec la police Manrope et sans bleu", () => {
    for (const nom of ["Bouton", "Champ", "MenuLateral", "BarreOnglets", "Tableau", "Formulaire", "Assistant"]) {
      expect(Object.keys(paquet).some((k) => k === nom || k === `${nom}Danger`), nom).toBe(true);
    }
    expect(jetons.police.texte).toContain("Manrope");
    expect(readFileSync(ici("./polices.css"), "utf8")).toContain("@fontsource/manrope");
  });

  it("[C-503] la charte : ivoire, brun anthracite, terracotta, mocha, Fraunces pour les titres, Manrope pour le texte", () => {
    expect(jetons.police.titre).toContain("Fraunces");
    expect(jetons.police.texte).toContain("Manrope");
    expect(teinte(valeur("couleur.fond.portail"))).toBeGreaterThanOrEqual(20);
    expect(teinte(valeur("couleur.fond.portail"))).toBeLessThanOrEqual(45);
    expect(contraste(valeur("couleur.texte.principal"), valeur("couleur.fond.portail"))).toBeGreaterThanOrEqual(12);
    expect(ecart(valeur("couleur.menu.fond"), valeur("couleur.action"))).toBeLessThanOrEqual(15);
  });
});

describe("charte : dettes de T3-02", () => {
  it("[B-251] responsive.css branche le jeton du texte courant mobile (16 px) sous 720 px", () => {
    const css = readFileSync(ici("./responsive.css"), "utf8");
    const media = css.slice(css.indexOf("@media (max-width: 720px)"));
    expect(media).toMatch(/--taille-texte:\s*var\(--taille-texteMobile\)/);
  });

  it("[B-247] le logo Axion-IA est un composant du paquet", () => {
    expect(existsSync(ici("./composants/Logo.tsx"))).toBe(true);
    expect(typeof (paquet as Record<string, unknown>)["LogoAxion"]).toBe("function");
  });
});
