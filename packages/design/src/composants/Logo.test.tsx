/** @jsxRuntime automatic @jsxImportSource react */
// @vitest-environment happy-dom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MenuLateral } from "./navigation.tsx";
import { LogoAxion } from "./Logo.tsx";

afterEach(cleanup);

describe("LogoAxion", () => {
  it("[B-247] le logo Axion-IA est un composant du paquet : image nommée « AXION IA » à la hauteur demandée", () => {
    const { container } = render(<LogoAxion src="/logo-axion-blanc.svg" hauteur={32} />);
    const img = container.querySelector("img");
    expect(img?.getAttribute("alt")).toBe("AXION IA");
    expect(img?.getAttribute("height")).toBe("32");
  });

  it("[B-247] le menu latéral et le pied « Propulsé par » passent par le composant", () => {
    const { container } = render(<MenuLateral variante="portail" actif="accueil" logoAxion="/logo.svg" client={{ nom: "Lemoine Rénovation" }} />);
    expect(container.querySelectorAll('[data-composant="logo-axion"]')).toHaveLength(1);
    const console_ = render(<MenuLateral variante="console" actif="clients" logoAxion="/logo.svg" />);
    expect(console_.container.querySelectorAll('[data-composant="logo-axion"]')).toHaveLength(1);
  });
});
