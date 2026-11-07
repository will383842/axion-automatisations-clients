import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BandeauSante } from "./BandeauSante.tsx";
import { CoqueFiche, OngletsFiche, ResumeFiche } from "./OngletsFiche.tsx";
import { ongletsLivres, type FicheClient } from "../fiche/onglets.ts";

const fiche: FicheClient = {
  bandeau: {
    nom: "Lemoine Rénovation", etat: "a_aider", formule: "Standard",
    derniere_erreur: { code: "connexion_expiree", message: "La connexion a expiré." },
    connexions: { total: 2, a_reprendre: 1 }, prochaine_echeance: "2026-11-12",
  },
  resume: {
    abonnement: { formule: "Standard", engagement: "12 mois" }, automatisations_actives: 2, reglages: { versions: 3 },
    connexions: { total: 2, a_reprendre: 1 }, executions: { reussies_pourcent: 98.7, en_attente: 142 }, notes: { total: 4, epinglees: 1 }, factures: { en_attente: 0 },
  },
};

describe("fiche client : bandeau, onglets et résumé", () => {
  it("[B-035] le bandeau reste visible sur chaque onglet livré", () => {
    for (const o of ongletsLivres()) {
      const html = renderToStaticMarkup(<CoqueFiche id="id-essai" fiche={fiche} actif={o.cle}><p>contenu</p></CoqueFiche>);
      expect(html, o.cle).toContain('data-bandeau-sante="1"');
      expect(html, o.cle).toContain("Lemoine Rénovation");
      expect(html, o.cle).toMatch(/position:\s*sticky/);
    }
  });

  it("[B-100] le bandeau montre le code et le message de la dernière erreur et l'état des connexions", () => {
    const html = renderToStaticMarkup(<BandeauSante bandeau={fiche.bandeau} />);
    expect(html).toContain("connexion_expiree");
    expect(html).toContain("La connexion a expiré.");
    expect(html).toContain("1 sur 2");
    expect(html).toContain("À aider");
  });

  it("[B-284] à 1440 px, l'état, le dernier incident et la prochaine échéance se lisent dans le bandeau, sans défiler", () => {
    const html = renderToStaticMarkup(<BandeauSante bandeau={fiche.bandeau} />);
    const ordre = ["À aider", "La connexion a expiré.", "Prochaine échéance"].map((t) => html.indexOf(t));
    expect(ordre.every((i) => i >= 0)).toBe(true);
    expect([...ordre].sort((a, b) => a - b)).toEqual(ordre);
    expect(html).not.toMatch(/overflow-y|height:\s*\d{4,}px/);
  });

  it("[A-025] chaque bloc du résumé renvoie à son onglet", () => {
    const html = renderToStaticMarkup(<ResumeFiche id="id-essai" resume={fiche.resume} />);
    for (const bloc of ["Abonnement", "Automatisations", "Réglages", "Connexions", "Exécutions", "Notes", "Factures"]) expect(html, bloc).toContain(bloc);
    expect((html.match(/href="\/clients\/id-essai\//g) ?? []).length).toBeGreaterThanOrEqual(7);
  });

  it("[B-036] le résumé donne les chiffres de l'abonnement, des automatisations, des connexions, des exécutions et des notes", () => {
    const html = renderToStaticMarkup(<ResumeFiche id="id-essai" resume={fiche.resume} />);
    expect(html).toContain("Standard");
    expect(html).toContain("98,7");
    expect(html).toContain("1 sur 2");
  });

  it("[B-002] la barre d'onglets n'affiche que les onglets livrés, l'actif marqué", () => {
    const html = renderToStaticMarkup(<OngletsFiche id="id-essai" actif="notes" />);
    expect(html).toContain('aria-current="page"');
    expect((html.match(/<a /g) ?? []).length).toBe(ongletsLivres().length);
  });
});
