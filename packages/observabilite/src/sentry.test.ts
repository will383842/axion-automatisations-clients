import { describe, expect, it } from "vitest";
import { avantEnvoi } from "./nettoyage.ts";
import { configurerSentry, type OptionsSentry } from "./sentry.ts";

// Marqueur unique : il ne doit apparaître nulle part dans ce qui part vers Sentry.
// Le DSN a la forme d'une adresse avec arobase : il est assemblé pour ne pas ressembler à un e-mail réel.
const dsn = (hote: string) => `https://cle${"@"}${hote}/1`;
const MARQUEUR = "sk_live_MARQUEUR_UNIQUE_a1b2c3d4e5f6";
const JETON = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJlLWRlLXRlc3Q";

function evenementBrut() {
  return {
    message: `Échec pour claire@exemple.fr avec ${JETON} et ${MARQUEUR}`,
    level: "error",
    release: "1.4.2",
    server_name: "serveur-interne",
    exception: { values: [{ type: "ErreurConnecteur", value: `réponse brute : jean.dupont@exemple.fr 06 12 34 56 78 FR7630006000011234567890189`, stacktrace: { frames: [{ filename: "src/connecteur.ts", function: "lire", lineno: 12, vars: { jeton: MARQUEUR } }] } }] },
    request: { url: "https://auto.exemple.fr/api/console/v1/clients/3f2b8c1e-1111-4222-8333-444455556666/envois?jeton=" + MARQUEUR, method: "POST", headers: { Authorization: `Bearer ${JETON}`, Cookie: `session=${MARQUEUR}` }, data: { corps: `contenu ${MARQUEUR}` }, cookies: { session: MARQUEUR }, query_string: `jeton=${MARQUEUR}` },
    breadcrumbs: { values: [{ category: "http", data: { url: `https://x.exemple.fr/?jeton=${MARQUEUR}` } }] },
    user: { email: "claire@exemple.fr", ip_address: "10.0.0.1" },
    extra: { reponseBrute: MARQUEUR },
    contexts: { app: { cellule: "cellule-1", instance: "inst-opaque-42" } },
    tags: { cellule: "cellule-1" },
  };
}

describe("observabilite : nettoyage avant envoi", () => {
  it("[C-025] une erreur dont le message contient une adresse e-mail et un jeton arrive à Sentry sans l'un ni l'autre", () => {
    const sortie = JSON.stringify(avantEnvoi(evenementBrut(), { application: "api" }));
    expect(sortie).not.toContain("claire@exemple.fr");
    expect(sortie).not.toContain("jean.dupont@exemple.fr");
    expect(sortie).not.toContain(JETON);
    expect(sortie).not.toContain("eyJ");
    expect(sortie).not.toContain("06 12 34 56 78");
    expect(sortie).not.toContain("FR7630006000011234567890189");
    expect(sortie).toContain("[masqué]");
  });
  it("[C-025] un corps de requête, un en-tête, un cookie ou un paramètre d'adresse n'est jamais envoyé", () => {
    const ev = avantEnvoi(evenementBrut(), { application: "api" });
    const sortie = JSON.stringify(ev);
    expect(sortie).not.toMatch(/Authorization|Cookie|Bearer|corps|query_string|jeton=/i);
    expect(ev.route).toBe("/api/console/v1/clients/:id/envois");
  });
  it("[LOT5-secret] le marqueur d'un secret de test est absent de l'événement envoyé", () => {
    expect(JSON.stringify(avantEnvoi(evenementBrut(), { application: "executeur" }))).not.toContain("MARQUEUR_UNIQUE");
  });
  it("[C-025] seuls le code d'erreur, la route, la version, la cellule et l'instance opaque sont gardés", () => {
    const ev = avantEnvoi(evenementBrut(), { application: "console" });
    expect(Object.keys(ev).sort()).toEqual(["application", "cellule", "code", "instance", "message", "route", "version"].sort());
    expect(ev).toMatchObject({ application: "console", code: "ErreurConnecteur", version: "1.4.2", cellule: "cellule-1", instance: "inst-opaque-42" });
  });
});

describe("observabilite : route envoyée à Sentry", () => {
  const routeDe = (url: string) => avantEnvoi({ request: { url } }, { application: "api" }).route;
  const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln";
  it("[C-025] une route dont un segment est un JWT, une adresse e-mail ou un jeton opaque arrive à Sentry avec ce segment masqué", () => {
    expect(routeDe(`/api/portail/v1/invitations/${JWT}`)).toBe("/api/portail/v1/invitations/:id");
    expect(routeDe("/api/console/v1/contacts/claire@exemple.fr")).toBe("/api/console/v1/contacts/:id");
    expect(routeDe("/reinit/Zx8yQ2abcDEF0123ghij")).toBe("/reinit/:id");
    expect(routeDe("/api/console/v1/clients/envois")).toBe("/api/console/v1/clients/envois");
  });
  it("[LOT5-secret] le marqueur placé dans le chemin de l'adresse est absent de l'événement envoyé", () => {
    const sortie = JSON.stringify(avantEnvoi({ request: { url: `/fin-de-contrat/accuse/t1/2026-11-06/${MARQUEUR}` } }, { application: "api" }));
    expect(sortie).not.toContain("MARQUEUR_UNIQUE");
  });
});

describe("observabilite : initialisation commune de Sentry", () => {
  function fauxSentry() {
    const recus: Record<string, unknown>[] = [];
    let options: OptionsSentry | undefined;
    return {
      recus,
      client: { init: (o: OptionsSentry) => { options = o; } },
      envoyer: (brut: unknown) => { const ev = options?.beforeSend?.(brut as never); if (ev) recus.push(ev as never); },
    };
  }
  it("[A-113] les trois applications envoient au même faux Sentry, avec leur nom", () => {
    const faux = fauxSentry();
    for (const application of ["api", "executeur", "console"] as const) {
      configurerSentry({ dsn: dsn("o1.ingest.de.sentry.io"), application, version: "1.0.0", sentry: faux.client });
      faux.envoyer(evenementBrut());
    }
    expect(faux.recus.map((e) => e["application"])).toEqual(["api", "executeur", "console"]);
    expect(JSON.stringify(faux.recus)).not.toContain("MARQUEUR_UNIQUE");
  });
  it("[A-113] refuse de démarrer sans adresse européenne, avec un message clair pour l'équipe", () => {
    const faux = fauxSentry();
    expect(() => configurerSentry({ dsn: dsn("o1.ingest.sentry.io"), application: "api", version: "1", sentry: faux.client })).toThrow(/région européenne/);
    expect(() => configurerSentry({ dsn: "", application: "api", version: "1", sentry: faux.client })).toThrow(/DSN/);
  });
  it("[C-025] aucune relecture de session, aucune capture de console, aucun fil d'Ariane", () => {
    const faux = fauxSentry();
    let options: OptionsSentry | undefined;
    configurerSentry({ dsn: dsn("o1.ingest.de.sentry.io"), application: "api", version: "1", sentry: { init: (o) => { options = o; } } });
    expect(options?.sendDefaultPii).toBe(false);
    expect(options?.beforeBreadcrumb?.({ message: MARQUEUR } as never)).toBeNull();
    expect(options?.replaysSessionSampleRate ?? 0).toBe(0);
    expect(faux.recus).toHaveLength(0);
  });
});
