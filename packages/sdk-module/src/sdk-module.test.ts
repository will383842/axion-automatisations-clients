import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineAutomation, type Manifeste } from "./index.ts";
import { moduleExemple, manifesteExemple } from "../exemples/module-exemple.ts";

const avec = (surcharge: Record<string, unknown>) => ({ ...manifesteExemple, ...surcharge }) as unknown as Manifeste;
const sans = (cle: string) => {
  const copie: Record<string, unknown> = { ...manifesteExemple };
  delete copie[cle];
  return copie as unknown as Manifeste;
};

describe("defineAutomation (C4 v0)", () => {
  it("[LOT0-c4] le module d'exemple est valide et figé", () => {
    expect(moduleExemple.code).toBe("accuse-reception");
    expect(moduleExemple.paquet).toBe("@axion-auto/accuse-reception");
    expect(Object.isFrozen(moduleExemple)).toBe(true);
    expect(Object.isFrozen(moduleExemple.etapes)).toBe(true);
  });

  it("[LOT0-c4] un manifeste avec 19 cas d'essai est refusé", () => {
    expect(() => defineAutomation(avec({ jeuEssai: manifesteExemple.jeuEssai.slice(0, 19) }))).toThrow(/jeuEssai/);
  });

  it("[LOT0-c4] un jeu d'essai sans panne ou sans e-mail piégé est refusé", () => {
    const nominaux = manifesteExemple.jeuEssai.map((c) => ({ ...c, categorie: "nominal" as const }));
    expect(() => defineAutomation(avec({ jeuEssai: nominaux }))).toThrow(/jeuEssai/);
  });

  it("[LOT0-c4] un connecteur sans garantie est refusé", () => {
    const connecteurs = [{ famille: "courriel", actions: ["envoyer"], portees: ["envoi"] }];
    expect(() => defineAutomation(avec({ connecteurs }))).toThrow(/garantie/);
  });

  it("[LOT0-c4] une garantie hors énumération est refusée", () => {
    const connecteurs = [{ famille: "courriel", actions: ["envoyer"], portees: ["envoi"], garantie: "au_mieux" }];
    expect(() => defineAutomation(avec({ connecteurs }))).toThrow(/garantie/);
  });

  it("[LOT0-c4] chaque rubrique obligatoire manquante est refusée", () => {
    for (const cle of ["code", "version", "apiMoteur", "reglages", "declencheurs", "etapes", "connecteurs", "ia", "jeuEssai", "migrer", "minutesGagneesParElement", "ecrans", "tables"]) {
      expect(() => defineAutomation(sans(cle)), cle).toThrow();
    }
  });

  it("[LOT0-c4] une version qui n'est pas du semver est refusée", () => {
    expect(() => defineAutomation(avec({ version: "1.0" }))).toThrow(/version/);
  });

  it("[LOT0-c4] des réglages sans actionsAutomatiquesAutorisees sont refusés", () => {
    expect(() => defineAutomation(avec({ reglages: z.object({ copie: z.string() }) }))).toThrow(/actionsAutomatiquesAutorisees/);
  });

  it("[LOT0-c4] les réglages s'exportent en JSON Schema 2020-12", () => {
    const schema = moduleExemple.schemaReglages as { $schema?: string; properties?: Record<string, unknown> };
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(Object.keys(schema.properties ?? {})).toContain("actionsAutomatiquesAutorisees");
  });

  it("[C-539] une action absente de actionsAutomatiquesAutorisees est classée brouillon", () => {
    const reglages = moduleExemple.instancier({ actionsAutomatiquesAutorisees: ["accuser_reception"], objetAccuse: "Bien reçu" });
    expect(moduleExemple.classerAction(reglages, "accuser_reception")).toBe("automatique");
    expect(moduleExemple.classerAction(reglages, "supprimer_courriel")).toBe("brouillon");
  });

  it("[LOT0-c4] les réglages d'un client sont validés sans toucher au code du module", () => {
    expect(() => moduleExemple.instancier({ objetAccuse: "Bien reçu" })).toThrow();
    const a = moduleExemple.instancier({ actionsAutomatiquesAutorisees: [], objetAccuse: "Bonjour" });
    const b = moduleExemple.instancier({ actionsAutomatiquesAutorisees: ["accuser_reception"], objetAccuse: "Merci" });
    expect(a.objetAccuse).not.toBe(b.objetAccuse);
  });

  it("[LOT0-c4] un champ propre à un client dans le manifeste est refusé", () => {
    expect(() => defineAutomation(avec({ client: "Lemoine Rénovation" }))).toThrow();
    expect(() => defineAutomation(avec({ clientId: "cli-1" }))).toThrow();
  });

  it("[LOT0-c4] un code de module portant un nom de client ou un identifiant d'instance est refusé", () => {
    expect(() => defineAutomation(avec({ code: "Accuse Reception" }))).toThrow(/code/);
    expect(() => defineAutomation(avec({ code: "accuse-reception-cli-0001" }))).toThrow(/code/);
  });

  it("[LOT0-c4] un écran qui porte du code est refusé", () => {
    const ecrans = [{ composant: "tableau", proprietes: { rendu: () => "x" } }];
    expect(() => defineAutomation(avec({ ecrans }))).toThrow(/ecrans/);
  });

  it("[LOT0-c4] un déclencheur sondage sans curseur est refusé", () => {
    expect(() => defineAutomation(avec({ declencheurs: [{ type: "sondage", intervalleSecondes: 60 }] }))).toThrow(/declencheurs/);
  });

  it("[LOT0-c4] une étape reçoit 120 s de délai maximum par défaut", () => {
    expect(moduleExemple.etapes[0]?.delaiMaxSecondes).toBe(120);
  });

  it("[LOT0-c4] migrer est déterministe (même entrée, même sortie, 100 tirages)", () => {
    const entree = { actionsAutomatiquesAutorisees: ["accuser_reception"], objetAccuse: "Bien reçu" };
    const premiere = JSON.stringify(moduleExemple.migrer("1.0.0", entree));
    for (let i = 0; i < 100; i++) expect(JSON.stringify(moduleExemple.migrer("1.0.0", entree))).toBe(premiere);
  });
});
