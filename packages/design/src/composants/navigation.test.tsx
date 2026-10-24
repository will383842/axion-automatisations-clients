/** @jsxRuntime automatic @jsxImportSource react */
// @vitest-environment happy-dom
import { cleanup, render } from "@testing-library/react";
import { violations } from "./accessibilite.tsx";
import { afterEach, describe, expect, it } from "vitest";
import { BarreOnglets, EnTeteTelephone, MenuLateral } from "./navigation.tsx";

afterEach(cleanup);

const logoAxion = "/logo-axion-blanc.svg";
const entreesPortail = [
  { id: "accueil", libelle: "Accueil", href: "/" },
  { id: "arelire", libelle: "À relire", href: "/a-relire", compteur: 4 },
];

describe("navigation", () => {
  it("[C-586] MenuLateral portail affiche « Propulsé par » et axion-ia.com, avec logo client", () => {
    const { container } = render(
      <MenuLateral variante="portail" entrees={entreesPortail} actif="accueil" logoAxion={logoAxion} client={{ nom: "Lemoine Rénovation", logo: "/logo-lemoine.svg" }} />,
    );
    expect(container.textContent).toContain("Propulsé par");
    expect(container.textContent).toContain("axion-ia.com");
    expect(container.querySelector('img[src="/logo-lemoine.svg"]')).not.toBeNull();
  });

  it("[C-586] MenuLateral portail sans logo : pastille aux initiales + nom, et toujours « Propulsé par »", () => {
    const { container, getAllByText } = render(
      <MenuLateral variante="portail" entrees={entreesPortail} actif="accueil" logoAxion={logoAxion} client={{ nom: "Lemoine Rénovation" }} />,
    );
    expect(container.textContent).toContain("LR");
    expect(getAllByText("Lemoine Rénovation").length).toBeGreaterThan(0);
    expect(container.textContent).toContain("Propulsé par");
    expect(container.textContent).toContain("axion-ia.com");
  });

  it("[C-586] MenuLateral console a 7 entrées et pas de « Propulsé par »", () => {
    const { container, getByRole } = render(<MenuLateral variante="console" actif="clients" logoAxion={logoAxion} />);
    expect(getByRole("navigation").querySelectorAll("a").length).toBe(7);
    expect(container.textContent).not.toContain("Propulsé par");
  });

  it("[C-597] MenuLateral : l'entrée active porte aria-current=\"page\" et elle seule", () => {
    const { container } = render(<MenuLateral variante="console" actif="alertes" logoAxion={logoAxion} />);
    const courants = container.querySelectorAll('[aria-current="page"]');
    expect(courants.length).toBe(1);
    expect(courants[0]?.textContent).toContain("Alertes");
  });

  it("[C-597] BarreOnglets portail a exactement 5 onglets, console aussi", () => {
    const p = render(<BarreOnglets variante="portail" actif="accueil" />);
    expect(p.container.querySelectorAll("a").length).toBe(5);
    p.unmount();
    const c = render(<BarreOnglets variante="console" actif="accueil" />);
    expect(c.container.querySelectorAll("a").length).toBe(5);
  });

  it("[C-597] BarreOnglets portail : compteur « À relire » annoncé en toutes lettres", () => {
    const { getByRole } = render(<BarreOnglets variante="portail" actif="accueil" compteurARelire={4} />);
    expect(getByRole("link", { name: /À relire.*4/ })).toBeTruthy();
  });

  it("[C-597] BarreOnglets menus réduits : Premiers pas, résilié, Bienvenue", () => {
    const pp = render(<BarreOnglets variante="premiers-pas" actif="premiers-pas" />);
    expect(pp.container.querySelectorAll("a").length).toBe(2);
    pp.unmount();
    const r = render(<BarreOnglets variante="resilie" actif="factures" />);
    expect(r.container.querySelectorAll("a").length).toBe(3);
    r.unmount();
    const b = render(<BarreOnglets variante="bienvenue" actif="" />);
    expect(b.container.querySelector("nav")).toBeNull();
  });

  it("[C-597] BarreOnglets : onglet actif en aria-current et nav collante r-onglets", () => {
    const { container } = render(<BarreOnglets variante="console" actif="clients" />);
    expect(container.querySelector("nav")?.className).toContain("r-onglets");
    expect(container.querySelector('[aria-current="page"]')?.textContent).toContain("Clients");
  });

  it("[C-586] EnTeteTelephone : en-tête r-entete, logo avec texte alternatif", () => {
    const { container } = render(<EnTeteTelephone logo="/logo-lemoine.svg" nomLogo="Lemoine Rénovation" />);
    expect(container.querySelector("header")?.className).toContain("r-entete");
    expect(container.querySelector("img")?.getAttribute("alt")).toBe("Lemoine Rénovation");
  });

  it("[C-597] MenuLateral et BarreOnglets coexistent : deux navigations nommées, distinctes", () => {
    const { getAllByRole } = render(
      <>
        <MenuLateral variante="console" actif="clients" logoAxion={logoAxion} />
        <BarreOnglets variante="console" actif="clients" />
      </>,
    );
    const noms = getAllByRole("navigation").map((n) => n.getAttribute("aria-label"));
    expect(new Set(noms).size).toBe(2);
  });

  it("[C-597] accessibilité structurelle : aucune violation sur la navigation", () => {
    const { container } = render(
      <div>
        <EnTeteTelephone logo="/logo-lemoine.svg" nomLogo="Lemoine Rénovation" />
        <MenuLateral variante="portail" entrees={entreesPortail} actif="accueil" logoAxion={logoAxion} client={{ nom: "Lemoine Rénovation" }} />
        <BarreOnglets variante="portail" actif="accueil" compteurARelire={2} />
      </div>,
    );
    expect(violations(container)).toEqual([]);
  });

  it("[C-586] BarreOnglets : onglets souples, libellé sur une ligne, actif plein terracotta", () => {
    const { container } = render(<BarreOnglets variante="portail" actif="accueil" />);
    const liens = Array.from(container.querySelectorAll("a"));
    for (const a of liens) {
      expect(a.style.flex).toBe("1 1 auto");
      expect(a.style.minWidth).toBe("0px");
      expect(a.style.padding).toBe("0px 4px");
      expect(a.style.position).toBe("relative");
      expect(a.querySelector("span")?.style.whiteSpace).toBe("nowrap");
    }
    expect(liens[0]?.style.background).toContain("var(--couleur-menu-fond)");
    expect(liens[0]?.style.color).toContain("var(--couleur-menu-texte)");
  });

  it("[C-586] BarreOnglets : pastille du compteur terracotta, chiffre blanc, en haut à droite", () => {
    const { container } = render(<BarreOnglets variante="portail" actif="accueil" compteurARelire={4} />);
    const pastille = container.querySelector('span[aria-hidden="true"]') as HTMLElement;
    expect(pastille.textContent).toBe("4");
    expect(pastille.style.position).toBe("absolute");
    expect(pastille.style.top).not.toBe("");
    expect(pastille.style.right).not.toBe("");
    expect(pastille.style.background).toContain("var(--couleur-action)");
    expect(pastille.style.color).toContain("var(--couleur-menu-texte)");
  });
});
