/** @jsxRuntime automatic @jsxImportSource react */
// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import axe from "axe-core";
import { afterEach, describe, expect, it } from "vitest";
import { EtapeSurTotal, Frise, TableauCartes } from "./etapes.tsx";

afterEach(cleanup);
const etapes = ["Compte", "Messagerie", "Réglages", "Essai", "Départ"];

describe("étapes et tableaux", () => {
  it("[C-586] Frise (ordinateur) liste les étapes, la courante porte aria-current=\"step\" et r-cache-mobile", () => {
    const { container } = render(<Frise etapes={etapes} courante={2} />);
    expect(container.querySelectorAll("li").length).toBe(5);
    expect(container.querySelector('[aria-current="step"]')?.textContent).toContain("Messagerie");
    expect(container.firstElementChild?.className).toContain("r-cache-mobile");
  });

  it("[C-586] EtapeSurTotal (téléphone) écrit « Étape 4 sur 5 : … » avec une barre de progression", () => {
    const { container, getByRole } = render(<EtapeSurTotal etapes={etapes} courante={4} />);
    expect(container.textContent).toContain("Étape 4 sur 5 : Essai");
    const barre = getByRole("progressbar");
    expect(barre.getAttribute("aria-valuenow")).toBe("4");
    expect(barre.getAttribute("aria-valuemax")).toBe("5");
    expect(container.firstElementChild?.className).toContain("r-mobile-seul");
  });

  it("[C-597] TableauCartes : classe r-tableau, en-têtes liés aux cellules", () => {
    const { container } = render(
      <TableauCartes legende="Clients" colonnes={["Nom", "État"]} lignes={[["Garage Fontaine", "Actif"], ["Atelier Bertin", "Pause"]]} />,
    );
    expect(container.querySelector("table")?.className).toContain("r-tableau");
    expect(container.querySelectorAll("tbody tr").length).toBe(2);
    expect(container.querySelector("td")?.getAttribute("data-libelle")).toBe("Nom");
    expect(container.querySelector("caption")?.textContent).toBe("Clients");
  });

  it("[C-597] axe-core : aucune violation sur Frise, EtapeSurTotal et TableauCartes", async () => {
    const { container } = render(
      <main>
        <Frise etapes={etapes} courante={1} />
        <EtapeSurTotal etapes={etapes} courante={1} />
        <TableauCartes legende="Clients" colonnes={["Nom", "État"]} lignes={[["Boulangerie Rivoire", "Actif"]]} />
      </main>,
    );
    const r = await axe.run(container, { rules: { "color-contrast": { enabled: false }, region: { enabled: false } } });
    expect(r.violations.map((v) => v.id)).toEqual([]);
  });
});
