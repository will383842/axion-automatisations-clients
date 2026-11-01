/** @jsxRuntime automatic @jsxImportSource react */
// @vitest-environment happy-dom
 import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { violations } from "./accessibilite.tsx";
import { Tableau } from "./Tableau.tsx";

afterEach(cleanup);

const colonnes = [
  { cle: "nom", libelle: "Entreprise" },
  { cle: "statut", libelle: "Statut" },
];
const lignes = [
  { nom: "Lemoine Rénovation", statut: "Actif" },
  { nom: "Atelier Bertin", statut: "En pause" },
  { nom: "Garage Fontaine", statut: "Actif" },
];
const noms = (c: HTMLElement) => [...c.querySelectorAll("tbody tr")].map((tr) => tr.querySelector("td")?.textContent);

describe("Tableau", () => {
  it("[B-256] le tableau trie, filtre et pagine par curseur", () => {
    const page = vi.fn();
    const { container, getByText, getByLabelText } = render(
      <Tableau legende="Clients" colonnes={colonnes} lignes={lignes} curseurSuivant="c-42" onPage={page} />,
    );
    fireEvent.click(getByText("Entreprise"));
    expect(noms(container)).toEqual(["Atelier Bertin", "Garage Fontaine", "Lemoine Rénovation"]);
    expect(container.querySelector("th")?.getAttribute("aria-sort")).toBe("ascending");
    fireEvent.click(getByText("Entreprise"));
    expect(container.querySelector("th")?.getAttribute("aria-sort")).toBe("descending");
    fireEvent.change(getByLabelText("Filtrer"), { target: { value: "pause" } });
    expect(noms(container)).toEqual(["Atelier Bertin"]);
    expect(violations(container)).toEqual([]);
  });

  it("[B-175] la page suivante part du curseur, jamais d'un décalage", () => {
    const page = vi.fn();
    const { getByText, queryByText, rerender } = render(<Tableau legende="Clients" colonnes={colonnes} lignes={lignes} curseurSuivant="c-42" onPage={page} />);
    fireEvent.click(getByText("Page suivante"));
    expect(page).toHaveBeenCalledWith("c-42");
    rerender(<Tableau legende="Clients" colonnes={colonnes} lignes={lignes} curseurSuivant={null} onPage={page} />);
    expect(queryByText("Page suivante")).toBeNull();
  });

  it("[B-256] l'export passe par une fonction reçue en propriété ; lignes en cartes sous 720 px", () => {
    const exporter = vi.fn();
    const { getByText, container } = render(<Tableau legende="Clients" colonnes={colonnes} lignes={lignes} onExport={exporter} />);
    fireEvent.click(getByText("Exporter"));
    expect(exporter).toHaveBeenCalledOnce();
    expect(container.querySelector("table")?.className).toContain("r-tableau");
    expect(container.querySelector("td")?.getAttribute("data-libelle")).toBe("Entreprise");
  });
});
