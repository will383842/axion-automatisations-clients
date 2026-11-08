import { afterEach, describe, expect, it } from "vitest";
import { demarrerFauxSentry, type FauxSentry } from "../../../packages/observabilite/test/faux-sentry.ts";
import { demarrerInstrumentation } from "./instrumentation.ts";

const DSN = `https://cle${"@"}o1.ingest.de.sentry.io/1`;
let faux: FauxSentry | undefined;
afterEach(async () => { await faux?.fermer(); faux = undefined; });

describe("instrumentation de executeur", () => {
  it("[A-113] executeur envoie ses erreurs au faux Sentry avec son nom, depuis l'environnement", async () => {
    faux = await demarrerFauxSentry();
    const sentry = demarrerInstrumentation({ SENTRY_DSN: DSN, SENTRY_CELLULE: "cellule-1", APP_VERSION: "1.0.0" }, { fetch: faux.fetch });
    sentry.capturer(new Error("échec de test"), "/x");
    await sentry.vider(2000);
    expect(faux.corps).toHaveLength(1);
    expect(faux.corps[0]).toContain('"application":"executeur"');
  });

  it("[A-113] executeur refuse de démarrer sans DSN, ou hors de *.de.sentry.io", () => {
    expect(() => demarrerInstrumentation({})).toThrow(/DSN absent/);
    expect(() => demarrerInstrumentation({ SENTRY_DSN: `https://cle${"@"}o1.ingest.sentry.io/1` })).toThrow(/région européenne/);
  });
});
