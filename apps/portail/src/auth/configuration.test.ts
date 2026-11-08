import { describe, expect, it } from "vitest";
import { connexionOuverte, lireConfiguration } from "./configuration.ts";

const COMPLET = {
  PORTAIL_CONNEXION_OUVERTE: "1",
  PORTAIL_EMETTEUR_OIDC: "https://sso.exemple.test/realms/clients",
  PORTAIL_CLIENT_OIDC: "portail",
  PORTAIL_SECRET_OIDC: "secret-de-test-seulement",
  PORTAIL_ORIGINE: "https://portail.exemple.test",
};

describe("configuration du portail", () => {
  it("[LOT6-connexion] la connexion du portail est fermée par défaut : seule la valeur « 1 » l'ouvre", () => {
    expect(connexionOuverte({})).toBe(false);
    for (const v of ["", "0", "oui", "true", " 1"]) expect(connexionOuverte({ PORTAIL_CONNEXION_OUVERTE: v }), v).toBe(false);
    expect(connexionOuverte(COMPLET)).toBe(true);
  });

  it("[LOT6-connexion] une variable absente ou une adresse non HTTPS, avec paramètre ou fragment, refuse de démarrer", () => {
    expect(() => lireConfiguration({ ...COMPLET, PORTAIL_SECRET_OIDC: "" })).toThrow(/PORTAIL_SECRET_OIDC/);
    expect(() => lireConfiguration({ ...COMPLET, PORTAIL_CLIENT_OIDC: undefined })).toThrow(/PORTAIL_CLIENT_OIDC/);
    expect(() => lireConfiguration({ ...COMPLET, PORTAIL_ORIGINE: "http://portail.exemple.test" })).toThrow(/PORTAIL_ORIGINE/);
    expect(() => lireConfiguration({ ...COMPLET, PORTAIL_ORIGINE: "https://portail.exemple.test/?a=1" })).toThrow(/PORTAIL_ORIGINE/);
    expect(() => lireConfiguration({ ...COMPLET, PORTAIL_EMETTEUR_OIDC: "https://sso.exemple.test/realms/clients#x" })).toThrow(/PORTAIL_EMETTEUR_OIDC/);
    expect(() => lireConfiguration({ ...COMPLET, PORTAIL_EMETTEUR_OIDC: "pas une adresse" })).toThrow(/PORTAIL_EMETTEUR_OIDC/);
    expect(() => lireConfiguration({})).toThrow();
  });

  it("[LOT6-connexion] la configuration complète est rendue sans barre finale, lue à chaque appel", () => {
    expect(lireConfiguration({ ...COMPLET, PORTAIL_ORIGINE: "https://portail.exemple.test/" })).toEqual({
      emetteur: "https://sso.exemple.test/realms/clients",
      clientId: "portail",
      secret: "secret-de-test-seulement",
      origine: "https://portail.exemple.test",
    });
  });
});
