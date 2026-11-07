import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { demarrerFauxSentry, fetchInjoignable, type FauxSentry } from "../test/faux-sentry.ts";
import { demarrerSentry } from "./sentry.ts";

// Le DSN est assemblé pour ne pas ressembler à une adresse e-mail réelle ; la clé est inventée.
const dsn = (hote: string) => `https://cle${"@"}${hote}/1`;
const DSN_UE = dsn("o1.ingest.de.sentry.io");
const config = (application: "api" | "executeur" | "console", extra: object = {}) => ({ dsn: DSN_UE, application, version: "1.0.0", cellule: "cellule-1", ...extra });

let faux: FauxSentry | undefined;
afterEach(async () => { await faux?.fermer(); faux = undefined; });

describe("observabilite : SDK @sentry/core et transport", () => {
  it("[A-113] les trois applications envoient au même faux Sentry, avec leur nom", async () => {
    faux = await demarrerFauxSentry();
    for (const application of ["api", "executeur", "console"] as const) {
      const sentry = demarrerSentry(config(application, { fetch: faux.fetch }));
      sentry.capturer(new Error("échec de test"), "/api/console/v1/envois");
      expect(await sentry.vider(2000)).toBe(true);
    }
    expect(faux.corps).toHaveLength(3);
    for (const [i, application] of (["api", "executeur", "console"] as const).entries()) {
      expect(faux.corps[i]).toContain(`"application":"${application}"`);
      expect(faux.corps[i]).toContain('"cellule":"cellule-1"');
      expect(faux.corps[i]).toContain('"route":"/api/console/v1/envois"');
      expect(faux.corps[i]).toContain('"type":"Error"');
    }
  });

  it("[A-113] refuse de démarrer sans DSN, ou avec un DSN hors de *.de.sentry.io, avec un message clair pour l'équipe", () => {
    expect(() => demarrerSentry(config("api", { dsn: "" }))).toThrow(/DSN absent/);
    for (const hote of ["o1.ingest.sentry.io", "de.sentry.io.attaquant.fr", "localhost"]) {
      expect(() => demarrerSentry(config("api", { dsn: dsn(hote) }))).toThrow(/région européenne/);
    }
    expect(() => demarrerSentry(config("api", { dsn: "http://localhost" }))).toThrow(/région européenne/);
  });

  it("[C-025] avec un échantillonnage de 1, une transaction dont l'adresse porte ?jeton= n'envoie ni le jeton ni la requête", async () => {
    faux = await demarrerFauxSentry();
    const marqueur = `marqueur-${randomUUID()}`;
    const sentry = demarrerSentry(config("api", { fetch: faux.fetch, echantillonnage: 1 }));
    sentry.client.captureEvent({ type: "transaction", transaction: `/api/x?jeton=${marqueur}`, request: { url: `/api/x?jeton=${marqueur}` }, spans: [] });
    await sentry.vider(2000);
    expect(faux.corps.join("")).not.toContain(marqueur);
    expect(faux.corps).toHaveLength(0);
  });

  it("[C-025] avec un Sentry injoignable, l'envoi échoue vite et rien de non nettoyé n'est gardé", async () => {
    const marqueur = `marqueur-${randomUUID()}`;
    const tentatives: string[] = [];
    const fetchEspion = (url: string, init: RequestInit) => { tentatives.push(String(init.body)); return fetchInjoignable(url, init); };
    const sentry = demarrerSentry(config("api", { fetch: fetchEspion }));
    const debut = performance.now();
    sentry.capturer(new Error(`échec ${marqueur} claire@exemple.fr`), "/x");
    expect(performance.now() - debut).toBeLessThan(50);
    const avantVidage = performance.now();
    await sentry.vider(2000);
    expect(performance.now() - avantVidage).toBeLessThan(2500);
    // Le nettoyage précède le transport : ce que le transport tente d'envoyer est déjà nettoyé.
    expect(tentatives.length).toBeGreaterThan(0);
    expect(tentatives.join("")).not.toContain("claire@exemple.fr");
    expect(tentatives.join("")).not.toContain(marqueur);
  }, 10_000);

  it("[C-025] aucune intégration n'est active : ni fil d'Ariane HTTP, ni console, ni contexte du système", () => {
    const sentry = demarrerSentry(config("executeur", { fetch: fetchInjoignable }));
    const options = sentry.client.getOptions();
    expect(options.integrations).toEqual([]);
    expect(options.maxBreadcrumbs).toBe(0);
    expect(options.sendDefaultPii).toBe(false);
    expect(options.serverName).toBeUndefined();
  });

  it("[C-025] l'erreur brute d'un connecteur qui contient la réponse de Microsoft (adresses, jeton) arrive masquée", async () => {
    faux = await demarrerFauxSentry();
    const jeton = `eyJ${randomUUID().replaceAll("-", "")}.${randomUUID().replaceAll("-", "")}`;
    const sentry = demarrerSentry(config("executeur", { fetch: faux.fetch }));
    sentry.capturer(new Error(`Microsoft 401 : {"user":"claire@exemple.fr","access_token":"${jeton}"} Authorization: Bearer ${jeton}`));
    await sentry.vider(2000);
    expect(faux.corps.join("")).not.toContain("claire@exemple.fr");
    expect(faux.corps.join("")).not.toContain(jeton);
  });

  it("[LOT5-secret] marqueur unique d'un secret de test absent du faux Sentry", async () => {
    faux = await demarrerFauxSentry();
    const marqueur = `marqueur-${randomUUID()}`;
    const b64 = Buffer.from(marqueur).toString("base64");
    const masquerSecrets = (t: string) => t.replaceAll(marqueur, "[masqué]").replaceAll(b64, "[masqué]");
    const sentry = demarrerSentry(config("api", { fetch: faux.fetch, masquerSecrets }));
    sentry.capturer(Object.assign(new Error(`a ${marqueur} b ${b64}`), { vars: { marqueur }, config: { headers: { cle: marqueur } } }), `/reinit/${marqueur}`);
    await sentry.vider(2000);
    expect(faux.corps).toHaveLength(1);
    expect(faux.corps[0]).not.toContain(marqueur);
    expect(faux.corps[0]).not.toContain(b64);
  });

  it("[A-065] le paquet dépend de @sentry/core en version exacte, et d'aucun autre paquet @sentry/*", () => {
    const paquet = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const tous = { ...paquet.dependencies, ...paquet.devDependencies };
    expect(Object.keys(tous).filter((n) => n.startsWith("@sentry/"))).toEqual(["@sentry/core"]);
    expect(paquet.dependencies?.["@sentry/core"]).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
