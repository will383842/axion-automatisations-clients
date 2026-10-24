import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import config from "../../../../next.config.ts";
import { GET } from "./route.ts";

const lire = (chemin: string) => readFileSync(fileURLToPath(new URL(chemin, import.meta.url)), "utf8");

describe("squelette portail", () => {
  it("[A-047] le gestionnaire /api/sante de du portail répond 200 et le nom portail", async () => {
    const reponse = await GET();
    expect(reponse.status).toBe(200);
    const corps = (await reponse.json()) as { etat: string; application: string; version: string };
    expect(corps).toEqual({ etat: "ok", application: "portail", version: expect.any(String) });
    expect(reponse.headers.get("cache-control")).toBe("no-store");
  });

  it("[A-047] la configuration pose la sortie autonome et les en-têtes de sécurité", async () => {
    expect(config.output).toBe("standalone");
    expect(config.poweredByHeader).toBe(false);
    const regles = (await config.headers?.()) ?? [];
    const entetes = Object.fromEntries(regles.flatMap((r) => r.headers).map((h) => [h.key, h.value]));
    expect(entetes["X-Content-Type-Options"]).toBe("nosniff");
    expect(entetes["Referrer-Policy"]).toBe("no-referrer");
    expect(entetes["Content-Security-Policy"]).toContain("frame-ancestors 'none'");
  });

  it("[A-047] la mise en page est en français et charge les jetons du paquet de design", () => {
    const layout = lire("../../layout.tsx");
    expect(layout).toContain('lang="fr"');
    expect(layout).toContain("@axion-auto/design");
  });

  it("[LOT1-web] la configuration n'appelle aucune police distante", () => {
    for (const fichier of ["../../layout.tsx", "../../page.tsx", "../../../../next.config.ts"]) {
      const texte = lire(fichier);
      expect(texte).not.toContain("fonts.googleapis.com");
      expect(texte).not.toContain("fonts.gstatic.com");
      expect(texte).not.toContain("next/font/google");
    }
    const css = lire("../../../../../../packages/design/src/polices.css");
    expect(css).not.toMatch(/fonts\.(googleapis|gstatic)\.com/);
    expect(css).toContain("@fontsource/manrope");
  });

  it("[A-047] la page ne dit que le nom de l'application", () => {
    expect(lire("../../page.tsx")).toContain("portail");
  });
});
