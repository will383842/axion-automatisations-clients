import { describe, expect, it } from "vitest";
import { analyserModele, chargerModele, MODELE_BASE_CLIENT, serialiserModele } from "@axion-auto/donnees-module";
import { verifierDonneesDeclarees } from "./verifier-donnees-declarees.js";

// Manifestes inventés : aucune donnée de client. Le modèle est celui du paquet (instantané commité).
const requete = (o: Record<string, unknown> = {}) => ({
  nom: "lister-listes", mode: "lecture", parametres: { limite: { type: "entier", min: 1, max: 50 } },
  forme: { type: "simple", table: "commun.listes_prospects", sortie: { lignes: [{ colonne: "id" }, { colonne: "nom" }] }, limite: { parametre: "limite" } }, ...o,
});
const avec = (r: unknown) => ({ donnees: { requetes: [r], actions: [] } });
const forme = (f: Record<string, unknown>) => ({ ...requete().forme, ...f });

describe("vérification des données déclarées à l'import", () => {
  it("[C-624] un manifeste sans données reste accepté", () => {
    expect(verifierDonneesDeclarees({})).toEqual([]);
    expect(verifierDonneesDeclarees(avec(requete()))).toEqual([]);
  });

  it("[C-624] une requête déclarée qui lit une colonne chiffrée est refusée à l'import", () => {
    const r = verifierDonneesDeclarees(avec(requete({ forme: forme({ table: "commun.personnes", sortie: { lignes: [{ colonne: "courriel_chiffre" }] } }) })));
    expect(r.join(" ")).toContain("colonne refusée : courriel_chiffre");
    expect(verifierDonneesDeclarees(avec(requete({ forme: forme({ sortie: { lignes: [{ colonne: "id" }, { colonne: "etablissement_id" }] } }) }))).length).toBeGreaterThan(0);
  });

  it("[C-624] une requête dont un paramètre est incompatible avec la colonne est refusée à l'import", () => {
    const r = requete({ parametres: { n: { type: "entier", min: 1, max: 5 } }, forme: forme({ filtres: [{ colonne: "nom", operateur: "egal", parametre: "n" }], limite: { fixe: 10 } }) });
    expect(verifierDonneesDeclarees(avec(r)).join(" ")).toContain("paramètre incompatible avec la colonne nom");
  });

  it("[C-624] une clé __proto__ ou une clé en trop est refusée à l'import", () => {
    const piege = JSON.parse('{"donnees":{"requetes":[],"actions":[],"__proto__":{"x":1}}}');
    expect(verifierDonneesDeclarees(piege).length).toBeGreaterThan(0);
    expect(verifierDonneesDeclarees(avec({ ...requete(), colonnes: ["id"] })).length).toBeGreaterThan(0);
    expect(verifierDonneesDeclarees({ donnees: { requetes: [], actions: [], extra: 1 } }).length).toBeGreaterThan(0);
  });

  it("[C-624] un manifeste 0.4.0 portant sql est refusé avec le message ADR 0109", () => {
    const r = verifierDonneesDeclarees(avec({ nom: "ancienne", mode: "lecture", sql: "SELECT 1" }));
    expect(r.join(" ")).toContain("sql retiré (ADR 0109)");
  });

  it("[C-624] une table hors commun est refusée à l'import", () => {
    expect(verifierDonneesDeclarees(avec(requete({ forme: forme({ table: "a_module.notes" }) }))).length).toBeGreaterThan(0);
    expect(verifierDonneesDeclarees(avec(requete({ forme: forme({ table: "commun.inconnue" }) }))).join(" ")).toContain("table non déclarable");
  });

  it("[C-624] l'import refuse une requête sur une colonne absente d'un instantané plus ancien que drizzle-cli (échec fermé)", () => {
    const i = serialiserModele(MODELE_BASE_CLIENT);
    const ancien = chargerModele({ ...i, tables: i.tables.map(([n, t]) => [n, n === "commun.listes_prospects" ? { ...t, colonnes: t.colonnes.filter(([c]) => c !== "nom") } : t]) });
    expect(verifierDonneesDeclarees(avec(requete()), ancien).join(" ")).toContain("colonne refusée : nom");
    expect(analyserModele).toBeTypeOf("function");
  });
});
