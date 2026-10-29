/** @jsxRuntime automatic @jsxImportSource react */
// @vitest-environment happy-dom
 import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { violations } from "./accessibilite.tsx";
import { Bouton } from "./base.tsx";
import { BoutonDanger } from "./Bouton.tsx";

afterEach(cleanup);

describe("Bouton", () => {
  it("[B-262] les trois boutons existent : principal, secondaire, danger", () => {
    const { container } = render(
      <>
        <Bouton variante="principal">Enregistrer</Bouton>
        <Bouton variante="secondaire">Annuler</Bouton>
        <BoutonDanger>Supprimer</BoutonDanger>
      </>,
    );
    const variantes = [...container.querySelectorAll("button")].map((b) => b.getAttribute("data-variante"));
    expect(variantes).toEqual(["principal", "secondaire", "danger"]);
    expect(violations(container)).toEqual([]);
  });

  it("[B-262] le bouton danger se déclenche au clic et reste un bouton de 48 px", () => {
    const clic = vi.fn();
    const { getByText } = render(<BoutonDanger onClick={clic}>Supprimer</BoutonDanger>);
    fireEvent.click(getByText("Supprimer"));
    expect(clic).toHaveBeenCalledOnce();
    expect(getByText("Supprimer").style.minHeight).toBe("48px");
  });
});
