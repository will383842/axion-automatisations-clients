import { describe, expect, it } from "vitest";
import { migrer } from "./migrer.js";

describe("outil de migration", () => {
  it("[A-189] attaque : migrer refuse l'URL du rôle applicatif avant toute connexion", async () => {
    for (const url of [
      "postgres://console_app@db.test:5432/console",
      "postgres://db.test:5432/console",
      "postgres://console_migration@db.test:5432/console?user=console_app",
      "pas une url",
    ]) {
      await expect(migrer({ url, dossier: "/inexistant" }), url).rejects.toThrow(/console_migration/);
    }
  });
});
