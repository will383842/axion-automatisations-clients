/** @jsxRuntime automatic @jsxImportSource react */
// @vitest-environment happy-dom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { violations } from "./accessibilite.tsx";
 import { Assistant } from "./Assistant.tsx";

afterEach(cleanup);

const etapes = [
  { id: "a", titre: "Votre entreprise", rendu: ({ valeur, changer }: { valeur: string; changer: (s: string) => void }) => <input aria-label="Nom" value={valeur} onChange={(e) => changer(e.target.value)} /> },
  { id: "b", titre: "Votre ville", rendu: ({ valeur, changer }: { valeur: string; changer: (s: string) => void }) => <input aria-label="Ville" value={valeur} onChange={(e) => changer(e.target.value)} /> },
];

describe("Assistant", () => {
  it("[B-212] l'assistant garde le brouillon à chaque étape et permet le retour", () => {
    const brouillon = vi.fn();
    const fin = vi.fn();
    const { getByText, getByLabelText, queryByLabelText, container } = render(
      <Assistant titre="Ajouter une automatisation" etapes={etapes} onBrouillon={brouillon} onTerminer={fin} libelleFin="Terminer" />,
    );
    expect(container.textContent).toContain("Étape 1 sur 2");
    expect(container.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("1");
    fireEvent.change(getByLabelText("Nom"), { target: { value: "Atelier Bertin" } });
    expect(brouillon).toHaveBeenLastCalledWith({ a: "Atelier Bertin" }, "a");
    fireEvent.click(getByText("Continuer"));
    expect(queryByLabelText("Nom")).toBeNull();
    expect(container.textContent).toContain("Étape 2 sur 2");
    fireEvent.click(getByText("Retour"));
    expect((getByLabelText("Nom") as HTMLInputElement).value).toBe("Atelier Bertin");
    fireEvent.click(getByText("Continuer"));
    fireEvent.change(getByLabelText("Ville"), { target: { value: "Lyon" } });
    fireEvent.click(getByText("Terminer"));
    expect(fin).toHaveBeenCalledWith({ a: "Atelier Bertin", b: "Lyon" });
    expect(violations(container)).toEqual([]);
  });

  it("[B-212] un seul bouton principal par écran, et le brouillon de départ est repris", () => {
    const { container, getByLabelText } = render(
      <Assistant titre="Ajouter" etapes={etapes} brouillonInitial={{ a: "Garage Fontaine" }} onBrouillon={() => {}} onTerminer={() => {}} libelleFin="Terminer" />,
    );
    expect((getByLabelText("Nom") as HTMLInputElement).value).toBe("Garage Fontaine");
    expect(container.querySelectorAll('[data-variante="principal"]').length).toBe(1);
  });

  it("[B-212] l'assistant n'écrit rien dans localStorage ni sessionStorage", () => {
    const local = vi.spyOn(Storage.prototype, "setItem");
    const { getByText, getByLabelText } = render(
      <Assistant titre="Ajouter" etapes={etapes} onBrouillon={() => {}} onTerminer={() => {}} libelleFin="Terminer" />,
    );
    fireEvent.change(getByLabelText("Nom"), { target: { value: "x" } });
    fireEvent.click(getByText("Continuer"));
    expect(local).not.toHaveBeenCalled();
    expect(window.localStorage.length + window.sessionStorage.length).toBe(0);
    local.mockRestore();
  });
});
