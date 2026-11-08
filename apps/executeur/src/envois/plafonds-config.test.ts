import { describe, expect, it } from "vitest";
import { chargerConfig } from "../config.ts";

describe("limites des fournisseurs dans la configuration", () => {
  it("[A-275] aucune limite par défaut : sans variable, aucune limite n'est inventée", () => {
    expect(chargerConfig({ VALKEY_HOTE: "valkey.test" }).limitesFournisseur).toEqual({});
  });

  it("[A-275] les limites relevées se lisent par fournisseur ; une valeur non numérique ou nulle refuse le démarrage", () => {
    const env = { VALKEY_HOTE: "valkey.test", EXECUTEUR_LIMITE_MICROSOFT365_JOUR: "400", EXECUTEUR_LIMITE_MICROSOFT365_MINUTE: "20", EXECUTEUR_LIMITE_GMAIL_JOUR: "300" };
    expect(chargerConfig(env).limitesFournisseur).toEqual({ microsoft365: { parJour: 400, parMinute: 20 }, gmail: { parJour: 300 } });
    expect(() => chargerConfig({ ...env, EXECUTEUR_LIMITE_GMAIL_JOUR: "beaucoup" })).toThrow(/EXECUTEUR_LIMITE_GMAIL_JOUR/);
    expect(() => chargerConfig({ ...env, EXECUTEUR_LIMITE_IMAP_MINUTE: "0" })).toThrow(/EXECUTEUR_LIMITE_IMAP_MINUTE/);
  });
});
