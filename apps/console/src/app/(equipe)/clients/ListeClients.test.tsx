import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import Page from "./page.tsx";
import { ListeClients } from "./ListeClients.tsx";

const ligne = (nom: string, formule: string, badge_formule: string) => ({ id: nom, nom, formule, badge_formule, sante: "bon", statut: "client", apporteur: null, modele_ia: null, metier: null });

describe("page Clients", () => {
  it("[B-319] chaque ligne affiche le badge de sa formule, en mots et en couleur de jeton", () => {
    const html = renderToStaticMarkup(<ListeClients lignes={[ligne("Lemoine Rénovation", "abonnement", "Abonnement"), ligne("Garage Fontaine", "achat", "Achat")]} />);
    expect(html).toContain("Lemoine Rénovation");
    expect(html).toContain("Abonnement");
    expect(html).toContain("Achat");
    expect(html.match(/data-couleur=/g)?.length).toBeGreaterThanOrEqual(2);
    expect(html).not.toMatch(/#[0-9a-f]{3,6}/i);
  });

  it("[B-005] sans donnée, la page garde son titre et annonce une liste vide", () => {
    const html = renderToStaticMarkup(<Page />);
    expect(html).toContain('<h1 id="titre">Clients</h1>');
    expect(html).toContain("Aucun client");
  });
});
