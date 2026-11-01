/** @jsxRuntime automatic @jsxImportSource react */
// @vitest-environment happy-dom
 import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { violations } from "./accessibilite.tsx";
import { BandeauAction } from "./Bandeau.tsx";

afterEach(cleanup);

describe("BandeauAction", () => {
  it("[B-263] chaque niveau donne l'action à faire", () => {
    for (const niveau of ["information", "avertissement", "erreur"] as const) {
      const clic = vi.fn();
      const { container, getByText, unmount } = render(
        <BandeauAction niveau={niveau} action={{ libelle: "Voir le détail", onClick: clic }}>
          Message
        </BandeauAction>,
      );
      fireEvent.click(getByText("Voir le détail"));
      expect(clic).toHaveBeenCalledOnce();
      expect(container.firstElementChild?.getAttribute("data-niveau")).toBe(niveau);
      expect(violations(container)).toEqual([]);
      unmount();
    }
  });

  it("[B-263] l'erreur est annoncée tout de suite, l'information sans interrompre", () => {
    const action = { libelle: "Réessayer", onClick: () => {} };
    expect(render(<BandeauAction niveau="erreur" action={action}>Échec</BandeauAction>).container.firstElementChild?.getAttribute("role")).toBe("alert");
    cleanup();
    expect(render(<BandeauAction niveau="information" action={action}>Info</BandeauAction>).container.firstElementChild?.getAttribute("role")).toBe("status");
  });
});
