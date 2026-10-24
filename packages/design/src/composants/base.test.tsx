// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import axe from "axe-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BadgeEtat, Bandeau, Bouton, Carte, CaseACocher, BoutonOption, Champ, Lien, LienEvitement, PastilleInitiales, TuileAutomatisation } from "./base.tsx";

afterEach(cleanup);

// jsdom ne calcule pas les couleurs : le contraste est couvert par jetons.test.ts et contraste.test.tsx.
async function violations(conteneur: HTMLElement): Promise<string[]> {
  const r = await axe.run(conteneur, { rules: { "color-contrast": { enabled: false }, region: { enabled: false } } });
  return r.violations.map((v) => v.id);
}

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

  it("[C-597] Carte accepte les 5 teintes sans donnée en dur", () => {
    for (const teinte of ["blanche", "peche", "sauge", "miel", "rose"] as const) {
      const { container, unmount } = render(<Carte teinte={teinte}>Contenu</Carte>);
      expect(container.textContent).toBe("Contenu");
      unmount();
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

  it("[C-597] axe-core : aucune violation sur chaque composant de base", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { container } = render(
      <main>
        <LienEvitement cible="contenu" />
        <Bandeau type="incident">Incident en cours</Bandeau>
        <Carte teinte="sauge">Bonjour</Carte>
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
    expect(await violations(container)).toEqual([]);
  });
});
