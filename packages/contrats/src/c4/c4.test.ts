import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Configuration, DUREE_CACHE_MAX_SECONDES } from "./configuration.ts";
import { EtatVoulu } from "./etat-voulu.ts";
import { Paquet } from "./evenements-executeur.ts";

const lire = (p: string) => JSON.parse(readFileSync(new URL(`../../fixtures/c4/${p}`, import.meta.url), "utf8")) as { cas: { nom: string; valide: boolean; corps: unknown }[] };

const debut = { type: "debut", instanceId: "inst-0001", executionId: "exec-0001", a: "2026-10-24T10:00:00Z" };
const fin = { type: "fin", instanceId: "inst-0001", executionId: "exec-0001", dureeMs: 1200, elements: 3, minutesGagnees: 15, jetons: 800, coutIaMicroCentimes: 4200 };
const vie = { type: "signal_de_vie", instanceId: "inst-0001", a: "2026-10-24T10:00:30Z" };
const erreur = { type: "erreur", instanceId: "inst-0001", executionId: "exec-0001", classe: "passagere", code: "delai_depasse" };

describe("contrat C4 : échanges exécuteur ↔ console", () => {
  it("[A-344] un paquet mêlant debut, fin et signal_de_vie est valide", () => {
    expect(Paquet.safeParse({ evenements: [debut, vie, fin] }).success).toBe(true);
  });

  it("[LOT0-c4] un paquet vide est refusé", () => {
    expect(Paquet.safeParse({ evenements: [] }).success).toBe(false);
  });

  it("[LOT0-c4] un événement erreur avec un champ texte libre est refusé", () => {
    expect(Paquet.safeParse({ evenements: [erreur] }).success).toBe(true);
    expect(Paquet.safeParse({ evenements: [{ ...erreur, message: "Facture de Boulangerie Rivoire en échec" }] }).success).toBe(false);
    expect(Paquet.safeParse({ evenements: [{ ...erreur, code: "Texte libre avec espaces" }] }).success).toBe(false);
  });

  it("[LOT0-c4] un événement erreur avec une classe inconnue est refusé", () => {
    expect(Paquet.safeParse({ evenements: [{ ...erreur, classe: "autre" }] }).success).toBe(false);
  });

  it("[LOT0-c4] un coût IA flottant est refusé", () => {
    expect(Paquet.safeParse({ evenements: [{ ...fin, coutIaMicroCentimes: 4200.5 }] }).success).toBe(false);
    expect(Paquet.safeParse({ evenements: [{ ...fin, coutIaMicroCentimes: -1 }] }).success).toBe(false);
  });

  it("[LOT0-c4] la configuration d'une instance se garde 24 h au plus", () => {
    const base = { instanceId: "inst-0001", moduleCode: "accuse-reception", moduleVersion: "1.0.0", reglages: { actionsAutomatiquesAutorisees: [] }, dureeCacheSecondes: DUREE_CACHE_MAX_SECONDES };
    expect(DUREE_CACHE_MAX_SECONDES).toBe(86400);
    expect(Configuration.safeParse(base).success).toBe(true);
    expect(Configuration.safeParse({ ...base, dureeCacheSecondes: 86401 }).success).toBe(false);
  });

  it("[LOT0-c4] l'état voulu reste léger : un état et une version", () => {
    expect(EtatVoulu.safeParse({ instanceId: "inst-0001", etat: "pause", version: 4 }).success).toBe(true);
    expect(EtatVoulu.safeParse({ instanceId: "inst-0001", etat: "inconnu", version: 4 }).success).toBe(false);
    expect(EtatVoulu.safeParse({ instanceId: "inst-0001", etat: "actif", version: 4, reglages: {} }).success).toBe(false);
  });

  it("[LOT0-c4] les fixtures de paquets sont conformes", () => {
    for (const c of lire("paquets.json").cas) expect(Paquet.safeParse(c.corps).success, c.nom).toBe(c.valide);
  });
});
