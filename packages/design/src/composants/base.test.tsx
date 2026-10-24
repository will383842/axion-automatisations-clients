/** @jsxRuntime automatic @jsxImportSource react */
// @vitest-environment happy-dom
import { cleanup, render } from "@testing-library/react";
import { violations } from "./accessibilite.tsx";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BadgeEtat, Bandeau, Bouton, Carte, CaseACocher, BoutonOption, Champ, Lien, LienEvitement, PastilleInitiales, TuileAutomatisation } from "./base.tsx";
import { renderToStaticMarkup } from "react-dom/server";
import { contraste, valeur } from "../jetons.ts";

afterEach(cleanup);

// jsdom ne calcule pas les couleurs : le contraste est couvert par jetons.test.ts et responsive.test.tsx.
describe("composants de base", () => {
  it("[C-597] CaseACocher refuse la classe r-plein (ignorée, avertissement en développement)", () => {
    const avertir = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { container } = render(<CaseACocher libelle="Recevoir le résumé" className="r-plein autre" />);
    const html = container.innerHTML;
    expect(html).not.toContain("r-plein");
    expect(html).toContain("autre");
    expect(avertir).toHaveBeenCalled();
    avertir.mockRestore();
  });

  it("[C-597] BoutonOption refuse la classe r-plein et reste en flex: none", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { container } = render(<BoutonOption libelle="Chaque jour" className="r-plein" />);
    expect(container.innerHTML).not.toContain("r-plein");
    expect(container.querySelector("label")?.style.flex).toMatch(/none|0 0 auto/);
  });

  it("[C-597] BadgeEtat affiche toujours un texte, pour chaque état", () => {
    for (const etat of ["urgent", "averifier", "fait", "pause"] as const) {
      const { container, unmount } = render(<BadgeEtat etat={etat} />);
      expect((container.textContent ?? "").trim().length).toBeGreaterThan(0);
      unmount();
    }
  });

  it("[C-597] BadgeEtat garde le mot même si le texte donné est vide", () => {
    const { container } = render(<BadgeEtat etat="urgent" texte="" />);
    expect((container.textContent ?? "").trim()).not.toBe("");
  });

  it("[C-597] Bouton fait 48 px de haut au moins (style) et se déclare principal ou secondaire", () => {
    const { getByRole } = render(<Bouton variante="principal">Valider</Bouton>);
    expect(getByRole("button").style.minHeight).toBe("48px");
    expect(getByRole("button").getAttribute("data-variante")).toBe("principal");
  });

  it("[C-597] Lien et Champ ont le nom accessible attendu", () => {
    const { getByLabelText, getByRole } = render(
      <>
        <Lien href="/aide">Voir l'aide</Lien>
        <Champ id="mail" libelle="Adresse e-mail" type="email" />
      </>,
    );
    expect(getByRole("link", { name: "Voir l'aide" })).toBeTruthy();
    expect(getByLabelText("Adresse e-mail")).toBeTruthy();
  });

  // Rendu serveur : happy-dom déforme les raccourcis border-* contenant var(), le HTML de React reste exact.
  it("[C-586] Carte teintée : fond doux, bordure 1 px dans la teinte, liseret 4 px à gauche, rayon 12", () => {
    for (const teinte of ["terracotta", "vert", "ambre", "violet", "gris"] as const) {
      const html = renderToStaticMarkup(<Carte teinte={teinte} liseret="gauche">Contenu</Carte>);
      expect(html).toContain(`background:var(--couleur-teinte-${teinte}-fond)`);
      expect(html).toContain(`color:var(--couleur-teinte-${teinte}-titre)`);
      expect(html).toContain(`border-top:1px solid var(--couleur-teinte-${teinte}-bordure)`);
      expect(html).toContain(`border-bottom:1px solid var(--couleur-teinte-${teinte}-bordure)`);
      expect(html).toContain(`border-left:4px solid var(--couleur-teinte-${teinte}-liseret)`);
      expect(html).toContain("border-radius:var(--rayon-12)");
    }
  });

  it("[C-586] Carte teintée : le liseret peut être en haut (chiffre clé) et la carte reste blanche par défaut", () => {
    const haut = renderToStaticMarkup(<Carte teinte="vert" liseret="haut">Chiffre</Carte>);
    expect(haut).toContain("border-top:4px solid var(--couleur-teinte-vert-liseret)");
    expect(haut).toContain("border-left:1px solid var(--couleur-teinte-vert-bordure)");
    const neutre = renderToStaticMarkup(<Carte>Neutre</Carte>);
    expect(neutre).toContain("background:var(--couleur-fond-carte)");
    expect(neutre).not.toContain("4px solid");
  });

  it("[C-586] BadgeEtat : pastille pleine, libellé blanc, rayon 6 px, fonds = liserets de teinte, flex: none", () => {
    const teintes = { urgent: "terracotta", averifier: "ambre", fait: "vert", pause: "gris" } as const;
    for (const [etat, teinte] of Object.entries(teintes)) {
      const { container, unmount } = render(<BadgeEtat etat={etat as keyof typeof teintes} />);
      const span = container.querySelector("span");
      expect(span?.style.background).toBe(`var(--couleur-teinte-${teinte}-liseret)`);
      expect(span?.style.color).toBe("var(--couleur-menu-texte)");
      expect(span?.style.borderRadius).toBe("calc(var(--rayon-12) / 2)");
      expect(span?.style.flex).toMatch(/none|0 0 auto/);
      expect(span?.style.alignSelf).toBe("flex-start");
      unmount();
    }
  });

  it("[C-586] contraste du blanc sur les 4 fonds de pastille ≥ 4,5:1", () => {
    for (const teinte of ["terracotta", "ambre", "vert", "gris"]) {
      expect(contraste(valeur("couleur.menu.texte"), valeur(`couleur.teinte.${teinte}.liseret`)), teinte).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("[C-586] TuileAutomatisation a 3 identités et un nom accessible", () => {
    for (const identite of ["tri", "comptesRendus", "relances"] as const) {
      const { getByRole, unmount } = render(<TuileAutomatisation identite={identite} nom="Tri des e-mails" />);
      expect(getByRole("img", { name: "Tri des e-mails" })).toBeTruthy();
      unmount();
    }
  });

  it("[C-586] PastilleInitiales calcule les initiales du nom", () => {
    const { container } = render(<PastilleInitiales nom="Lemoine Rénovation" />);
    expect(container.textContent).toBe("LR");
  });

  it("[C-597] Bandeau incident utilise role=alert, information utilise role=status", () => {
    const a = render(<Bandeau type="incident">Incident en cours</Bandeau>);
    expect(a.getByRole("alert").textContent).toContain("Incident en cours");
    a.unmount();
    const b = render(<Bandeau type="information">Maintenance prévue</Bandeau>);
    expect(b.getByRole("status")).toBeTruthy();
  });

  it("[C-597] LienEvitement cible le contenu", () => {
    const { getByRole } = render(<LienEvitement cible="contenu" />);
    expect(getByRole("link").getAttribute("href")).toBe("#contenu");
    expect(getByRole("link").className).toContain("evitement");
  });

  it("[C-597] accessibilité structurelle : aucune violation sur chaque composant de base", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { container } = render(
      <main>
        <LienEvitement cible="contenu" />
        <Bandeau type="incident">Incident en cours</Bandeau>
        <Carte teinte="vert" liseret="gauche">Bonjour</Carte>
        <Bouton variante="principal">Valider</Bouton>
        <Bouton variante="secondaire">Plus tard</Bouton>
        <Lien href="/aide">Aide</Lien>
        <BadgeEtat etat="fait" />
        <TuileAutomatisation identite="relances" nom="Relances de devis" />
        <PastilleInitiales nom="Atelier Bertin" />
        <Champ id="nom" libelle="Nom" />
        <CaseACocher libelle="Recevoir le résumé" />
        <BoutonOption libelle="Chaque jour" name="rythme" />
      </main>,
    );
    expect(violations(container)).toEqual([]);
  });
});
