/** @jsxRuntime automatic @jsxImportSource react */
// @vitest-environment happy-dom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { violations } from "./accessibilite.tsx";
 import { ImportFichier } from "./ImportFichier.tsx";

afterEach(cleanup);

const props = { libelle: "Votre fichier de contacts", types: [".csv"], tailleMax: 1000 };
const fichier = (nom: string, octets: number) => new File([new Uint8Array(octets)], nom);

describe("ImportFichier", () => {
  it("[B-260] un fichier trop lourd ou d'un type refusé est arrêté avant l'envoi", () => {
    const envoyer = vi.fn();
    const { getByLabelText, container } = render(<ImportFichier {...props} onFichier={envoyer} />);
    const champ = getByLabelText("Votre fichier de contacts");
    fireEvent.change(champ, { target: { files: [fichier("contacts.csv", 5000)] } });
    expect(envoyer).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("trop lourd");
    fireEvent.change(champ, { target: { files: [fichier("contacts.exe", 10)] } });
    expect(envoyer).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("type");
    fireEvent.change(champ, { target: { files: [fichier("contacts.csv", 10)] } });
    expect(envoyer).toHaveBeenCalledOnce();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(violations(container)).toEqual([]);
  });

  it("[B-260] le glisser-déposer passe par le même contrôle", () => {
    const envoyer = vi.fn();
    const { container } = render(<ImportFichier {...props} onFichier={envoyer} />);
    const zone = container.querySelector("[data-zone]")!;
    fireEvent.drop(zone, { dataTransfer: { files: [fichier("gros.csv", 5000)] } });
    expect(envoyer).not.toHaveBeenCalled();
    fireEvent.drop(zone, { dataTransfer: { files: [fichier("bon.csv", 5)] } });
    expect(envoyer).toHaveBeenCalledOnce();
  });

  it("[B-260] l'erreur est reliée au champ et le même fichier peut être choisi de nouveau", () => {
    const { getByLabelText, container } = render(<ImportFichier {...props} onFichier={() => {}} />);
    const champ = getByLabelText("Votre fichier de contacts") as HTMLInputElement;
    const ecritures: string[] = [];
    Object.defineProperty(champ, "value", { configurable: true, get: () => "", set: (x: string) => void ecritures.push(x) });
    fireEvent.change(champ, { target: { files: [fichier("contacts.csv", 5000)] } });
    const alerte = container.querySelector('[role="alert"]')!;
    expect(alerte.id).not.toBe("");
    expect(champ.getAttribute("aria-describedby")).toContain(alerte.id);
    expect(ecritures).toContain("");
  });

  it("[B-260] la taille maximale s'écrit en Mo au-delà de 1000 ko", () => {
    const { getByLabelText, container } = render(<ImportFichier libelle="Fichier" types={[".csv"]} tailleMax={5_000_000} onFichier={() => {}} />);
    fireEvent.change(getByLabelText("Fichier"), { target: { files: [fichier("a.csv", 6_000_000)] } });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("5 Mo");
  });
});
