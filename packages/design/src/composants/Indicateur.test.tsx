/** @jsxRuntime automatic @jsxImportSource react */
// @vitest-environment happy-dom
 import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { violations } from "./accessibilite.tsx";
import { Indicateur } from "./Indicateur.tsx";

afterEach(cleanup);

describe("Indicateur", () => {
  it("[B-255] l'indicateur dit l'évolution en mots", () => {
    const { container } = render(<Indicateur libelle="Demandes traitées" valeur="128" evolution={{ variation: 12, periode: "sur 7 jours" }} />);
    expect(container.textContent).toContain("En hausse de 12 % sur 7 jours");
    cleanup();
    const baisse = render(<Indicateur libelle="Erreurs" valeur="3" evolution={{ variation: -25, periode: "sur 7 jours" }} />);
    expect(baisse.container.textContent).toContain("En baisse de 25 % sur 7 jours");
    cleanup();
    const stable = render(<Indicateur libelle="Clients actifs" valeur="40" evolution={{ variation: 0, periode: "sur 7 jours" }} />);
    expect(stable.container.textContent).toContain("Stable sur 7 jours");
  });

  it("[B-255] la flèche est décorative : le mot porte l'évolution", () => {
    const { container } = render(<Indicateur libelle="Demandes" valeur="9" evolution={{ variation: 5, periode: "ce mois-ci" }} />);
    expect(container.querySelector('[aria-hidden="true"]')).not.toBeNull();
    expect(violations(container)).toEqual([]);
  });
});
