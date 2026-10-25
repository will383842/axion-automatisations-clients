import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigInvalide, chargerConfig } from "./config.js";

const BASE = "postgres://console_app@pgbouncer.test:6432/console";
const prod = (extra: Record<string, string> = {}) => ({ NODE_ENV: "production", APP_DATABASE_URL: BASE, ...extra });
const dossier = () => mkdtempSync(join(tmpdir(), "api-config-"));
const refus = (env: Record<string, string>, d = dossier()) => {
  try {
    chargerConfig(env, d);
  } catch (e) {
    expect(e).toBeInstanceOf(ConfigInvalide);
    return (e as Error).message;
  }
  throw new Error("la configuration aurait dû être refusée");
};

describe("configuration", () => {
  it("[C-391] en production, l'API accepte une configuration saine sans fichier .env", () => {
    const config = chargerConfig(prod({ HUB_URL: "https://hub.test", CRM_URL: "https://crm.test" }), dossier());
    expect(config).toMatchObject({ env: "production", appDatabaseUrl: BASE, hubUrl: "https://hub.test", crmUrl: "https://crm.test" });
  });

  it("[C-391] en production, l'API refuse de démarrer si un fichier .env est présent", () => {
    const d = dossier();
    writeFileSync(join(d, ".env"), "X=1\n");
    expect(refus(prod(), d)).toContain(".env");
  });

  it("[C-391] attaque : les variantes .env.local, .env.production, .ENV et un dossier ou lien nommé .env sont refusées", () => {
    for (const nom of [".env.local", ".env.production", ".ENV", ".Env.Prod"]) {
      const d = dossier();
      writeFileSync(join(d, nom), "");
      refus(prod(), d);
    }
    const dd = dossier();
    mkdirSync(join(dd, ".env"));
    refus(prod(), dd);
    const dl = dossier();
    symlinkSync("/nonexistent", join(dl, ".env"));
    refus(prod(), dl);
  });

  it("[C-391] hors production, un fichier .env n'empêche pas le démarrage", () => {
    const d = dossier();
    writeFileSync(join(d, ".env"), "");
    expect(chargerConfig({ NODE_ENV: "development" }, d).env).toBe("development");
  });

  it("[C-391] en production, l'API refuse une clé de fournisseur d'IA dans l'environnement", () => {
    for (const nom of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "MISTRAL_API_KEY", "anthropic_api_key"]) {
      expect(refus(prod({ [nom]: "x" })), nom).toContain(nom);
    }
  });

  it("[C-391] attaque : une clé d'IA vide ou la clé maîtresse de la passerelle est refusée aussi", () => {
    refus(prod({ OPENAI_API_KEY: "" }));
    refus(prod({ LITELLM_MASTER_KEY: "x" }));
    refus(prod({ LITELLM_SALT_KEY: "x" }));
  });

  it("[C-391] attaque : le message de refus ne contient jamais la valeur du secret", () => {
    const secret = "valeur-de-test-0123456789";
    expect(refus(prod({ ANTHROPIC_API_KEY: secret }))).not.toContain(secret);
  });

  it("[C-391] attaque : NODE_ENV absent, mal écrit ou avec espace est refusé (fermé par défaut)", () => {
    for (const valeur of ["Production", "production ", "prod", ""]) refus({ NODE_ENV: valeur });
    refus({});
  });

  it("[A-048] attaque : l'URL de base doit viser console_app, sans paramètre qui change le rôle", () => {
    refus(prod({ APP_DATABASE_URL: "postgres://console_migration@pgbouncer.test:6432/console" }));
    refus(prod({ APP_DATABASE_URL: `${BASE}?user=console_migration` }));
    refus(prod({ APP_DATABASE_URL: `${BASE}?options=-c%20role%3Dconsole_migration` }));
    refus(prod({ APP_DATABASE_URL: "n'importe quoi" }));
    refus({ NODE_ENV: "production" });
  });

  it("[A-087] attaque : HUB_URL et CRM_URL n'acceptent que http ou https", () => {
    for (const mauvaise of ["file:///etc/passwd", "javascript:alert(1)", "hub.test", "ftp://hub.test"]) {
      refus(prod({ HUB_URL: mauvaise }));
      refus(prod({ CRM_URL: mauvaise }));
    }
  });

  it("[A-087] HUB_URL et CRM_URL sont facultatives", () => {
    const config = chargerConfig(prod(), dossier());
    expect(config.hubUrl).toBeUndefined();
    expect(config.crmUrl).toBeUndefined();
  });
});
