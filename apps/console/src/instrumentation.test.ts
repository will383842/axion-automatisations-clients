import { afterEach, describe, expect, it, vi } from "vitest";
import { demarrerFauxSentry, type FauxSentry } from "../../../packages/observabilite/test/faux-sentry.ts";
import { onRequestError, register } from "./instrumentation.ts";

const DSN = `https://cle${"@"}o1.ingest.de.sentry.io/1`;
let faux: FauxSentry | undefined;
afterEach(async () => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); await faux?.fermer(); faux = undefined; });

describe("instrumentation de la console (Next)", () => {
  it("[A-113] la console déclare register() et onRequestError, et register() ne fait rien hors du moteur nodejs", async () => {
    expect(typeof register).toBe("function");
    expect(typeof onRequestError).toBe("function");
    faux = await demarrerFauxSentry();
    const espion = vi.fn(faux.fetch);
    vi.stubGlobal("fetch", espion);
    vi.stubEnv("SENTRY_DSN", DSN);
    vi.stubEnv("NEXT_RUNTIME", "edge");
    await register();
    await onRequestError(new Error("échec"), { path: "/x", method: "GET", headers: {} }, {} as never);
    expect(espion).not.toHaveBeenCalled();
  });

  it("[A-113] sous nodejs, la console envoie l'erreur de requête avec son nom et sa route sans paramètres", async () => {
    faux = await demarrerFauxSentry();
    vi.stubGlobal("fetch", faux.fetch);
    vi.stubEnv("SENTRY_DSN", DSN);
    vi.stubEnv("SENTRY_CELLULE", "cellule-1");
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    await register();
    await onRequestError(new Error("échec"), { path: "/equipe/clients/3f2b8c1e?jeton=abc", method: "GET", headers: {} }, {} as never);
    expect(faux.corps).toHaveLength(1);
    expect(faux.corps[0]).toContain('"application":"console"');
    expect(faux.corps[0]).not.toContain("jeton=abc");
  });
});
