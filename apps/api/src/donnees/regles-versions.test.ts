import { describe, expect, it } from "vitest";
import { contracterPermis, estPhaseContracter, migrationSuivantePermise, verifierDescente } from "./regles-versions.ts";

const ok = { interrupteurOuvert: true, versionN: 4, versionsDesBases: [4, 4, 4], versionCodeDeployee: 5 };

describe("règles bloquantes des versions de structure", () => {
  it("[A-226] le marqueur « phase: contracter » ne compte qu'en première ligne du fichier", () => {
    expect(estPhaseContracter("-- phase: contracter\nALTER TABLE t DROP COLUMN c;")).toBe(true);
    expect(estPhaseContracter("\n\n-- phase: contracter  \r\nALTER TABLE t DROP COLUMN c;")).toBe(true);
    expect(estPhaseContracter("ALTER TABLE t DROP COLUMN c;\n-- phase: contracter")).toBe(false);
    expect(estPhaseContracter("SELECT '-- phase: contracter';")).toBe(false);
    expect(estPhaseContracter("/* -- phase: contracter */\nSELECT 1;")).toBe(false);
    expect(estPhaseContracter("-- phase: contracter plus tard\nSELECT 1;")).toBe(false);
  });

  it("[A-226] contracter est refusé tant que CONTRACTER_OUVERT est à false", () => {
    expect(contracterPermis({ ...ok, interrupteurOuvert: false })).toEqual({ permis: false, raison: expect.stringMatching(/interrupteur/) });
    expect(contracterPermis(ok)).toEqual({ permis: true });
  });

  it("[A-230] contracter est refusé si une seule base n'est pas en N ou si le code n'est pas en N+1", () => {
    expect(contracterPermis({ ...ok, versionsDesBases: [4, 4, 3] }).permis).toBe(false);
    expect(contracterPermis({ ...ok, versionsDesBases: [3] }).permis).toBe(false);
    expect(contracterPermis({ ...ok, versionCodeDeployee: 4 }).permis).toBe(false);
    expect(contracterPermis({ ...ok, versionCodeDeployee: undefined }).permis).toBe(false);
    // Aucune base connue : on ne devine pas que « tout est en N ».
    expect(contracterPermis({ ...ok, versionsDesBases: [] }).permis).toBe(false);
  });

  it("[A-231] la migration N+1 est refusée tant qu'une base reste en N-1", () => {
    expect(migrationSuivantePermise({ versionCible: 5, versionsDesBases: [4, 4, 4] })).toEqual({ permis: true });
    expect(migrationSuivantePermise({ versionCible: 5, versionsDesBases: [5, 4, 3] })).toEqual({ permis: false, raison: expect.stringMatching(/N-1/) });
    // Une base à N-1 seulement par rapport à la cible N reste permise : on migre vers N.
    expect(migrationSuivantePermise({ versionCible: 4, versionsDesBases: [3, 4] })).toEqual({ permis: true });
  });

  it("[A-232] en production, une cible plus basse que la version actuelle est refusée ; ailleurs elle ne fait rien", () => {
    expect(() => verifierDescente(5, 4, true)).toThrow(/descendante/);
    expect(() => verifierDescente(5, 5, true)).not.toThrow();
    expect(() => verifierDescente(4, 5, true)).not.toThrow();
    expect(() => verifierDescente(5, 4, false)).not.toThrow();
  });
});
