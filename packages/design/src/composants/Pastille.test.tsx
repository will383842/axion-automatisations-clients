/** @jsxRuntime automatic @jsxImportSource react */
// @vitest-environment happy-dom
 import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { violations } from "./accessibilite.tsx";
import { Pastille } from "./Pastille.tsx";

afterEach(cleanup);

describe("Pastille", () => {
  it("[B-264] une pastille sans mot est refusée", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<Pastille couleur="vert" mot="" />)).toThrow();
    expect(() => render(<Pastille couleur="rouge" mot="   " />)).toThrow();
  });

  it("[B-264] chaque couleur s'affiche avec son mot", () => {
    for (const couleur of ["vert", "orange", "rouge", "gris"] as const) {
      const { container, unmount } = render(<Pastille couleur={couleur} mot="Actif" />);
      expect(container.textContent).toBe("Actif");
      expect(container.firstElementChild?.getAttribute("data-couleur")).toBe(couleur);
      expect(violations(container)).toEqual([]);
      unmount();
    }
  });
});
