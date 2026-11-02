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

  it("[B-212] au changement d'étape, le focus passe sur l'intitulé de l'étape, annoncé aux lecteurs d'écran", () => {
    const { getByText, container } = render(
      <Assistant titre="Ajouter" etapes={etapes} onBrouillon={() => {}} onTerminer={() => {}} libelleFin="Terminer" />,
    );
    expect(document.activeElement?.textContent ?? "").not.toContain("Étape");
    fireEvent.click(getByText("Continuer"));
    const intitule = document.activeElement as HTMLElement;
    expect(intitule.textContent).toContain("Étape 2 sur 2");
    expect(intitule.getAttribute("tabindex")).toBe("-1");
    expect(intitule.getAttribute("aria-live")).toBe("polite");
    fireEvent.click(getByText("Retour"));
    expect((document.activeElement as HTMLElement).textContent).toContain("Étape 1 sur 2");
    expect(container.querySelectorAll("[id]").length).toBeGreaterThan(0);
  });

  it("[B-212] deux assistants sur la même page n'ont pas d'identifiant en double", () => {
    const { container } = render(
      <>
        <Assistant titre="Un" etapes={etapes} onBrouillon={() => {}} onTerminer={() => {}} libelleFin="Terminer" />
        <Assistant titre="Deux" etapes={etapes} onBrouillon={() => {}} onTerminer={() => {}} libelleFin="Terminer" />
      </>,
    );
    const ids = [...container.querySelectorAll("[id]")].map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
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
