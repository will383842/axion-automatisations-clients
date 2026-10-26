import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { verifierCanaux } from "./garde-canaux.ts";

const f = (chemin: string, contenu: string) => ({ chemin, contenu });

describe("garde des canaux", () => {
  it("[C-510] la garde trouve une route /api/hub/ sans vérification", () => {
    const sans = verifierCanaux([f("apps/api/src/routes/faits.ts", 's.post("/api/hub/v1/faits", async () => ({}));')]);
    expect(sans.join("\n")).toMatch(/faits\.ts.*\/api\/hub\//);
    for (const p of ["/api/crm/v1/x", "/api/executeur/v1/x"]) expect(verifierCanaux([f("apps/api/src/routes/x.ts", `s.get("${p}", h);`)])).toHaveLength(1);
    const avec = 'enregistrerCanal(serveur, "hub", deps, (s) => s.post("/api/hub/v1/faits", h));';
    expect(verifierCanaux([f("apps/api/src/routes/faits.ts", avec)])).toEqual([]);
  });

  it("[C-510] un fichier du dossier canaux/ n'échappe à la garde que s'il est l'un des trois fichiers nommés", () => {
    const route = 's.post("/api/hub/v1/x", h);';
    expect(verifierCanaux([f("apps/api/src/canaux/routes-hub.ts", route)])).toHaveLength(1);
    for (const n of ["signer", "verifier-entrant", "journal-canal"]) expect(verifierCanaux([f(`apps/api/src/canaux/${n}.ts`, route)])).toEqual([]);
  });

  it("[C-510] la garde voit une route déclarée par le préfixe exporté des contrats", () => {
    expect(verifierCanaux([f("apps/api/src/routes/c4.ts", "serveur.register(routes, { prefix: PREFIXE_C4 });")])).toHaveLength(1);
    expect(verifierCanaux([f("apps/api/src/routes/c4.ts", "enregistrerCanal(serveur, 'x', deps, (s) => s.register(r, { prefix: PREFIXE_C4 }));")])).toEqual([]);
  });

  it("[C-510] la garde trouve un appel en écriture à api/mcp", () => {
    expect(verifierCanaux([f("apps/api/src/x.ts", 'await fetch(`${base}/api/mcp`, { method: "POST" });')])).toHaveLength(1);
    expect(verifierCanaux([f("apps/api/src/y.ts", 'axios.put("https://exemple.test/site-sync/pages", d);')])).toHaveLength(1);
    expect(verifierCanaux([f("apps/api/src/z.ts", 'await fetch(`${base}/api/mcp`);')])).toEqual([]);
  });

  it("[C-510] les tests ne sont pas lus par la garde, et le dépôt est conforme", () => {
    expect(verifierCanaux([f("apps/api/src/x.test.ts", 's.post("/api/hub/v1/x", h); fetch("/api/mcp", { method: "POST" })')])).toEqual([]);
    const racine = fileURLToPath(new URL("../apps/api/src/", import.meta.url));
    const fichiers = (readdirSync(racine, { recursive: true, encoding: "utf8" }) as string[]).filter((n) => n.endsWith(".ts")).map((n) => f(`apps/api/src/${n}`, readFileSync(racine + n, "utf8")));
    expect(fichiers.length).toBeGreaterThan(5);
    expect(verifierCanaux(fichiers)).toEqual([]);
  });
});
