/** @jsxRuntime automatic @jsxImportSource react */
// @vitest-environment happy-dom
 import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { violations } from "./accessibilite.tsx";
import { Graphique } from "./Graphique.tsx";

afterEach(cleanup);

const points = [
  { libelle: "Lundi", valeur: 4 },
  { libelle: "Mardi", valeur: 9 },
  { libelle: "Mercredi", valeur: 0 },
];

describe("Graphique", () => {
  it("[B-257] le graphique a un tableau équivalent pour les lecteurs d'écran", () => {
    const { container } = render(<Graphique titre="Demandes par jour" points={points} unite="demandes" />);
    expect(container.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    const table = container.querySelector("table");
    expect(table?.querySelector("caption")?.textContent).toBe("Demandes par jour");
    const cellules = [...container.querySelectorAll("tbody td")].map((td) => td.textContent);
    expect(cellules).toEqual(["4 demandes", "9 demandes", "0 demandes"]);
    expect(violations(container)).toEqual([]);
  });

  it("[B-257] le titre et les valeurs sont lisibles sans légende", () => {
    const { container } = render(<Graphique titre="Demandes par jour" points={points} />);
    expect(container.querySelector("h3")?.textContent).toBe("Demandes par jour");
    expect(container.querySelector("svg")?.textContent).toContain("9");
    expect(container.querySelector("svg")?.textContent).toContain("Mardi");
  });
});
