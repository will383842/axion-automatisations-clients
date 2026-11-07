import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import Page, { etats } from "./page.tsx";
import { EcranSecurite } from "./EcranSecurite.tsx";
import type { DonneesSecurite } from "./donnees.ts";
import { ECRANS } from "../../../ecrans.ts";
import { controlesStructurels, texteVisible } from "../../../etats/regles.ts";

// Données d'essai TYPÉES et inventées : l'écran lit un port ; le pont console → API d'équipe est une dette (E4).
const SESSION_A = "3f2b8c1e-5d4a-4e6f-9a7b-1c2d3e4f5a6b";
const SESSION_B = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
const MEMBRE_A = "0b1c2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e";
const MEMBRE_B = "7e6d5c4b-3a29-4817-96a5-b4c3d2e1f0a9";

const DONNEES: DonneesSecurite = {
  genre: "normal",
  membres: [
    {
      id: MEMBRE_A,
      libelle: "Dirigeante de test",
      role: "dirigeant",
      sessions: [{ id: SESSION_A, ouverteLe: "2026-11-07T08:00:00Z", derniereActivite: "2026-11-07T09:10:00Z", finPrevue: "2026-11-07T09:40:00Z", facteurs: ["otp", "webauthn"] }],
    },
    {
      id: MEMBRE_B,
      libelle: "Second administrateur de test",
      role: "second_administrateur",
      sessions: [{ id: SESSION_B, ouverteLe: "2026-11-07T07:00:00Z", derniereActivite: "2026-11-07T07:05:00Z", finPrevue: "2026-11-07T07:35:00Z", facteurs: [] }],
    },
  ],
  acces: [{ type: "intervention", clientLibelle: "Garage Fontaine", debut: "2026-11-07T08:30:00Z", fin: "2026-11-07T10:30:00Z" }],
};

const html = (d: Parameters<typeof EcranSecurite>[0]["donnees"]) => renderToStaticMarkup(<EcranSecurite donnees={d} />);

describe("écran Sécurité et accès", () => {
  it("[B-026] l'écran liste sessions, double facteur et accès en cours", () => {
    const h = html(DONNEES);
    const t = texteVisible(h);
    expect(t).toContain("Dirigeante de test");
    expect(t).toContain("Second administrateur de test");
    expect(t).toContain("Double facteur actif");
    expect(t).toContain("Double facteur absent");
    expect(t).toContain("Garage Fontaine");
    expect(t).toContain("Intervention");
    expect(h.match(/data-session="/g)).toHaveLength(2);
  });

  it("[B-027] le bouton Révoquer demande confirmation et vise la session de sa ligne", () => {
    const h = html(DONNEES);
    const formulaires = [...h.matchAll(/<form[^>]*data-geste="revoquer"[^>]*>([\s\S]*?)<\/form>/g)];
    expect(formulaires).toHaveLength(2);
    const [a, b] = formulaires;
    expect(a?.[1]).toContain(`name="membreId" value="${MEMBRE_A}"`);
    expect(a?.[1]).toContain(`name="sessionId" value="${SESSION_A}"`);
    expect(b?.[1]).toContain(`name="membreId" value="${MEMBRE_B}"`);
    expect(b?.[1]).toContain(`name="sessionId" value="${SESSION_B}"`);
    // La confirmation est une étape écrite avant le geste ; aucun envoi sans elle.
    expect(texteVisible(a?.[1] ?? "")).toContain("Confirmer la révocation");
    expect(h).not.toMatch(/effet sous 5 minutes/i);
  });

  it("[B-028] le formulaire d'invitation ne propose que les deux rôles V1", () => {
    const h = html(DONNEES);
    const valeurs = [...h.matchAll(/<option[^>]*value="([^"]*)"/g)].map((m) => m[1]);
    expect(valeurs).toEqual(["dirigeant", "second_administrateur"]);
    expect(h).toMatch(/<input[^>]*type="email"/);
    expect(h).not.toMatch(/lecteur|membre de l'équipe/i);
  });

  it("[LOT3-securite] l'écran ne montre jamais d'adresse IP complète ni d'identifiant Keycloak brut", () => {
    const t = texteVisible(html(DONNEES));
    expect(t).not.toMatch(/\b\d{1,3}(?:\.\d{1,3}){3}\b/);
    expect(t).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    expect(t).not.toContain(SESSION_A);
    expect(t).not.toContain(MEMBRE_A);
  });

  it("[LOT3-securite] la page par défaut garde son titre et n'affiche aucune donnée inventée", () => {
    const h = renderToStaticMarkup(<Page />);
    expect(h).toContain('<h1 id="titre">Sécurité et accès</h1>');
    expect(h).not.toContain("Dirigeante de test");
  });

  it("[LOT3-securite] l'écran est inscrit au registre avec ses cinq états et exporte ceux qui ne sont pas « normal »", () => {
    const e = ECRANS.find((x) => x.route === "/securite");
    expect(e?.maquette).not.toBeNull();
    expect(e?.etats).toEqual(["normal", "vide", "chargement", "erreur", "acces-refuse"]);
    expect(Object.keys(etats).sort()).toEqual(["acces-refuse", "chargement", "erreur", "vide"]);
  });

  it("[LOT3-securite] chaque état se rend avec un seul titre, des champs étiquetés et sans couleur littérale", () => {
    const rendus = [html(DONNEES), html({ genre: "vide" }), html({ genre: "chargement" }), html({ genre: "erreur" }), html({ genre: "acces-refuse" })];
    for (const h of rendus) {
      expect(controlesStructurels(h)).toEqual([]);
      expect(h).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
    }
    expect(texteVisible(rendus[2] ?? "")).toContain("Chargement");
    expect(rendus[2]).toMatch(/role="status"[^>]*aria-busy="true"|aria-busy="true"[^>]*role="status"/);
  });

  it("[LOT3-securite] rendu 1440 et 390 px : aucune largeur fixe au-delà de 390 px, tableaux défilants ou empilés", () => {
    const h = html(DONNEES);
    const largeurs = [...h.matchAll(/(?<![-\w])(?:min-|max-)?width:\s*(\d+)px/g)].map((m) => Number(m[1]));
    expect(largeurs.filter((l) => l > 390)).toEqual([]);
    expect(h).toContain('class="r-tableau"');
    expect(h).toContain("data-libelle=");
  });
});
