/** @jsxRuntime automatic @jsxImportSource react */
// @vitest-environment happy-dom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { violations } from "./accessibilite.tsx";
 import { Formulaire } from "./Formulaire.tsx";

afterEach(cleanup);

const champs = [
  { id: "nom", libelle: "Nom de l'entreprise", aide: "Tel qu'il figure sur vos factures", erreur: "Écrivez le nom de l'entreprise" },
  { id: "ville", libelle: "Ville" },
];

describe("Formulaire", () => {
  it("[B-259] l'erreur s'affiche sous le champ et lui est reliée", () => {
    const { container, getByLabelText } = render(
      <Formulaire champs={champs} valeurs={{ nom: "", ville: "" }} onChange={() => {}} onEnvoyer={() => {}} libelleEnvoi="Enregistrer" />,
    );
    const champ = getByLabelText("Nom de l'entreprise");
    const message = container.querySelector("#nom-erreur");
    expect(message?.textContent).toBe("Écrivez le nom de l'entreprise");
    expect(champ.getAttribute("aria-describedby")).toContain("nom-erreur");
    expect(champ.getAttribute("aria-invalid")).toBe("true");
    expect(champ.nextElementSibling === message).toBe(true);
    expect(getByLabelText("Ville").getAttribute("aria-invalid")).toBeNull();
    expect(violations(container)).toEqual([]);
  });

  it("[B-259] deux formulaires aux mêmes champs n'ont pas d'identifiant en double", () => {
    const { container } = render(
      <>
        <Formulaire champs={champs} valeurs={{}} onChange={() => {}} onEnvoyer={() => {}} libelleEnvoi="A" />
        <Formulaire champs={champs} valeurs={{}} onChange={() => {}} onEnvoyer={() => {}} libelleEnvoi="B" />
      </>,
    );
    const ids = [...container.querySelectorAll("[id]")].map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of container.querySelectorAll("input")) {
      for (const cible of (c.getAttribute("aria-describedby") ?? "").split(" ").filter(Boolean)) expect(container.querySelector(`[id="${cible}"]`)).not.toBeNull();
    }
  });

  it("[B-259] l'aide ne s'ouvre qu'à la demande et le formulaire envoie", () => {
    const envoyer = vi.fn();
    const change = vi.fn();
    const { getByText, queryByText, getByLabelText } = render(
      <Formulaire champs={champs} valeurs={{ nom: "", ville: "" }} onChange={change} onEnvoyer={envoyer} libelleEnvoi="Enregistrer" />,
    );
    expect(queryByText("Tel qu'il figure sur vos factures")).toBeNull();
    fireEvent.click(getByText("Besoin d'aide ?"));
    expect(getByText("Tel qu'il figure sur vos factures")).toBeTruthy();
    fireEvent.change(getByLabelText("Ville"), { target: { value: "Lyon" } });
    expect(change).toHaveBeenCalledWith("ville", "Lyon");
    fireEvent.click(getByText("Enregistrer"));
    expect(envoyer).toHaveBeenCalledOnce();
  });
});
