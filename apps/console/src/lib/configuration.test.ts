import { describe, expect, it } from "vitest";
import { adresseBackOffice, connexionOuverte, lireConfiguration } from "./configuration.ts";

const COMPLET = {
  CONSOLE_CONNEXION_OUVERTE: "1",
  CONSOLE_EMETTEUR_OIDC: "https://sso.exemple.test/realms/equipe",
  CONSOLE_CLIENT_OIDC: "console",
  CONSOLE_SECRET_OIDC: "secret-de-test-seulement",
  CONSOLE_ORIGINE: "https://console.exemple.test",
  BACKOFFICE_URL: "https://admin.exemple.test",
};

describe("configuration de la console", () => {
  it("[C-541] la connexion de l'équipe est fermée par défaut", () => {
    expect(connexionOuverte({})).toBe(false);
    expect(connexionOuverte({ CONSOLE_CONNEXION_OUVERTE: "oui" })).toBe(false);
    expect(connexionOuverte(COMPLET)).toBe(true);
  });

  it("[C-541] une variable manquante ou une origine non HTTPS refuse de démarrer la connexion", () => {
    expect(() => lireConfiguration({ ...COMPLET, CONSOLE_SECRET_OIDC: "" })).toThrow(/CONSOLE_SECRET_OIDC/);
    expect(() => lireConfiguration({ ...COMPLET, CONSOLE_ORIGINE: "http://console.exemple.test" })).toThrow(/CONSOLE_ORIGINE/);
    expect(() => lireConfiguration({ ...COMPLET, CONSOLE_EMETTEUR_OIDC: "http://sso.exemple.test/realms/equipe" })).toThrow(/CONSOLE_EMETTEUR_OIDC/);
    expect(lireConfiguration(COMPLET).origine).toBe("https://console.exemple.test");
  });

  it("[A-104] l'adresse du back-office vient de la configuration, jamais du code", () => {
    expect(adresseBackOffice({ BACKOFFICE_URL: "https://admin.exemple.test/" })).toBe("https://admin.exemple.test");
    expect(adresseBackOffice({})).toBeNull();
    expect(adresseBackOffice({ BACKOFFICE_URL: "javascript:alert(1)" })).toBeNull();
  });
});
