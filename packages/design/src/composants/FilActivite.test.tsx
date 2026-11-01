/** @jsxRuntime automatic @jsxImportSource react */
// @vitest-environment happy-dom
 import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { violations } from "./accessibilite.tsx";
import { FilActivite } from "./FilActivite.tsx";

afterEach(cleanup);

describe("FilActivite", () => {
  it("[B-261] le fil est trié du plus récent au plus ancien", () => {
    const { container } = render(
      <FilActivite
        titre="Activité récente"
        evenements={[
          { id: "a", quand: "2026-03-01T09:00:00Z", texte: "Plus ancien" },
          { id: "c", quand: "2026-03-03T09:00:00Z", texte: "Plus récent" },
          { id: "b", quand: "2026-03-02T09:00:00Z", texte: "Au milieu" },
        ]}
      />,
    );
    const textes = [...container.querySelectorAll("li")].map((li) => li.textContent ?? "");
    expect(textes[0]).toContain("Plus récent");
    expect(textes[1]).toContain("Au milieu");
    expect(textes[2]).toContain("Plus ancien");
    expect(violations(container)).toEqual([]);
  });

  it("[B-261] un fil vide le dit en mots", () => {
    const { container } = render(<FilActivite titre="Activité récente" evenements={[]} />);
    expect(container.textContent).toContain("Aucune activité pour le moment");
  });
});
