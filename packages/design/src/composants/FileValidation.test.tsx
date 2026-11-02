/** @jsxRuntime automatic @jsxImportSource react */
// @vitest-environment happy-dom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { violations } from "./accessibilite.tsx";
 import { FileValidation } from "./FileValidation.tsx";

afterEach(cleanup);

const elements = [
  { id: "p1", titre: "Devis de Lemoine Rénovation", detail: "À relire avant l'envoi" },
  { id: "p2", titre: "Relance de Garage Fontaine" },
];

describe("FileValidation", () => {
  it("[B-258] accepter et refuser se font d'un geste et au clavier", () => {
    const accepter = vi.fn();
    const refuser = vi.fn();
    const { getByLabelText, container } = render(<FileValidation elements={elements} onAccepter={accepter} onRefuser={refuser} />);
    fireEvent.click(getByLabelText("Accepter : Devis de Lemoine Rénovation"));
    expect(accepter).toHaveBeenCalledWith("p1");
    fireEvent.click(getByLabelText("Refuser : Relance de Garage Fontaine"));
    expect(refuser).toHaveBeenCalledWith("p2");
    const lignes = container.querySelectorAll("li");
    fireEvent.keyDown(lignes[1]!, { key: "a" });
    expect(accepter).toHaveBeenLastCalledWith("p2");
    fireEvent.keyDown(lignes[0]!, { key: "r" });
    expect(refuser).toHaveBeenLastCalledWith("p1");
    expect(lignes[0]!.getAttribute("tabindex")).toBe("0");
    expect(violations(container)).toEqual([]);
  });

  it("[B-177] la file vide le dit en mots", () => {
    const { container } = render(<FileValidation elements={[]} onAccepter={() => {}} onRefuser={() => {}} />);
    expect(container.textContent).toContain("Rien à valider");
  });
});
