import { describe, expect, it } from "vitest";
import { LecteurSecretsMemoire } from "../secrets.ts";
import { creerKeycloakAdmin, ErreurKeycloak } from "./keycloak-admin.ts";

// Adaptateur de l'API d'administration de Keycloak (royaume equipe seul). Faux fetch : aucun réseau, valeurs générées pour l'essai.
const BASE = "http://keycloak.exemple.test:8080";
const ID = "3f2b8c1e-9a47-4d65-b0e2-7c5a1d9e4f60";
const AUTRE = "a1b2c3d4-0000-4000-8000-123456789abc";
const JETON = "jeton-de-service-fictif-0001";
const SECRET = "secret-de-service-fictif-0001";

interface Appel { methode: string; url: string; corps: string }
type Reponse = { statut?: number; json?: unknown; entetes?: Record<string, string> };

function monter(repondre: (a: Appel) => Reponse | undefined = () => undefined, debut = 1_000_000) {
  const appels: Appel[] = [];
  const journal: string[] = [];
  let temps = debut;
  const f = async (entree: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const a: Appel = { methode: init?.method ?? "GET", url: String(entree), corps: String(init?.body ?? "") };
    appels.push(a);
    if (a.url.endsWith("/realms/equipe/protocol/openid-connect/token")) return Response.json({ access_token: JETON, expires_in: 300 });
    const r = repondre(a) ?? {};
    return new Response(r.json === undefined ? null : JSON.stringify(r.json), { status: r.statut ?? (r.json === undefined ? 204 : 200), headers: r.entetes ?? {} });
  };
  const kc = creerKeycloakAdmin({
    base: BASE, secrets: new LecteurSecretsMemoire({ KC_SECRET_CONSOLE_SESSIONS: SECRET }), fetch: f, maintenant: () => temps, journaliser: (l) => journal.push(l),
  });
  return { kc, appels, journal, avancer: (ms: number) => (temps += ms) };
}
const admin = (appels: Appel[]) => appels.filter((a) => !a.url.includes("/protocol/openid-connect/token"));

describe("keycloak-admin : adresses et identifiants", () => {
  it("[LOT3-securite] l'adaptateur n'appelle que /admin/realms/equipe et refuse un identifiant hors motif UUID", async () => {
    const m = monter(() => ({ json: [] }));
    const faux = ["../clients/users", "%2e%2e", "", "a".repeat(36), "3f2b8c1e-9a47-4d65-b0e2-7c5a1d9e4f6g", `${ID}/../${AUTRE}`];
    for (const id of faux) {
      for (const appel of [m.kc.sessionsDe, m.kc.facteursDe, m.kc.fermerSession, m.kc.activer, m.kc.desactiver, m.kc.envoyerActions]) {
        await expect(appel(id)).rejects.toMatchObject({ code: "entree_invalide" });
      }
    }
    expect(m.appels).toEqual([]);
    await m.kc.sessionsDe(ID);
    await m.kc.chercherParEmail("Membre@exemple.fr");
    for (const a of admin(m.appels)) expect(a.url.startsWith(`${BASE}/admin/realms/equipe/`)).toBe(true);
    expect(m.appels[0]?.url).toBe(`${BASE}/realms/equipe/protocol/openid-connect/token`);
  });
  it("[LOT3-securite] l'adaptateur refuse une adresse électronique qui n'en est pas une", async () => {
    const m = monter();
    for (const e of ["", "sans-arobase", "a@b@exemple.fr", "a b@exemple.fr", `${"x".repeat(250)}@exemple.fr`, "a@exemple.fr\r\nX: y"]) {
      await expect(m.kc.chercherParEmail(e)).rejects.toMatchObject({ code: "entree_invalide" });
      await expect(m.kc.creerUtilisateur({ email: e })).rejects.toMatchObject({ code: "entree_invalide" });
    }
    expect(m.appels).toEqual([]);
  });
});

describe("keycloak-admin : méthodes fermées", () => {
  it("[LOT3-securite] l'adaptateur n'émet jamais DELETE, role-mappings, reset-password ni impersonation", async () => {
    const m = monter((a) => {
      if (a.methode === "POST" && a.url.endsWith("/users")) return { statut: 201, entetes: { location: `${BASE}/admin/realms/equipe/users/${ID}` } };
      if (a.url.includes("/sessions")) return { json: [] };
      if (a.url.includes("/credentials")) return { json: [] };
      if (a.url.includes("/users?")) return { json: [] };
      return undefined;
    });
    await m.kc.sessionsDe(ID);
    await m.kc.facteursDe(ID);
    await m.kc.fermerSession(AUTRE);
    await m.kc.chercherParEmail("membre@exemple.fr");
    await m.kc.creerUtilisateur({ email: "membre@exemple.fr" });
    await m.kc.activer(ID);
    await m.kc.envoyerActions(ID);
    await m.kc.desactiver(ID);
    const vus = admin(m.appels).map((a) => `${a.methode} ${a.url.slice(`${BASE}/admin/realms/equipe`.length).replaceAll(ID, ":u").replaceAll(AUTRE, ":s").split("?")[0]}`);
    expect(vus).toEqual([
      "GET /users/:u/sessions", "GET /users/:u/credentials", "DELETE /sessions/:s", "GET /users", "POST /users", "PUT /users/:u",
      "PUT /users/:u/execute-actions-email", "PUT /users/:u", "POST /users/:u/logout",
    ]);
    for (const a of admin(m.appels)) {
      expect(a.url).not.toMatch(/role-mappings|reset-password|impersonation|\/clients|\/realms\/(?!equipe)/);
      if (a.methode === "DELETE") expect(a.url).toMatch(/\/sessions\/[0-9a-f-]{36}$/);
    }
  });
  it("[LOT3-securite] creerUtilisateur crée un compte désactivé, adresse en minuscules, sans mot de passe", async () => {
    const m = monter(() => ({ statut: 201, entetes: { location: `${BASE}/admin/realms/equipe/users/${ID}` } }));
    expect(await m.kc.creerUtilisateur({ email: "  Membre@Exemple.fr " })).toEqual({ id: ID });
    const corps = JSON.parse(admin(m.appels)[0]!.corps) as Record<string, unknown>;
    expect(corps).toEqual({ username: "membre@exemple.fr", email: "membre@exemple.fr", enabled: false, requiredActions: ["UPDATE_PASSWORD", "CONFIGURE_TOTP"] });
  });
  it("[LOT3-securite] une adresse déjà prise rend le code conflit, un identifiant de retour invalide est refusé", async () => {
    const pris = monter(() => ({ statut: 409, json: { errorMessage: "User exists with same username" } }));
    await expect(pris.kc.creerUtilisateur({ email: "membre@exemple.fr" })).rejects.toMatchObject({ code: "conflit" });
    const louche = monter(() => ({ statut: 201, entetes: { location: `${BASE}/admin/realms/clients/users/../x` } }));
    await expect(louche.kc.creerUtilisateur({ email: "membre@exemple.fr" })).rejects.toMatchObject({ code: "reponse_invalide" });
  });
  it("[LOT3-securite] désactiver coupe le compte puis ses sessions, dans cet ordre", async () => {
    const m = monter();
    await m.kc.desactiver(ID);
    expect(admin(m.appels).map((a) => [a.methode, a.url.split(ID)[1], a.corps])).toEqual([
      ["PUT", "", JSON.stringify({ enabled: false })],
      ["POST", "/logout", ""],
    ]);
  });
  it("[LOT3-securite] facteursDe ne rend que les types, jamais secretData ni credentialData", async () => {
    const m = monter(() => ({
      json: [
        { id: AUTRE, type: "password", secretData: "{\"value\":\"haché\"}", credentialData: "{}" },
        { id: AUTRE, type: "otp", secretData: "{\"value\":\"semence-fictive\"}", credentialData: "{\"digits\":6}" },
        { id: AUTRE, type: "webauthn", secretData: "{}", credentialData: "{}" },
        { id: AUTRE, type: "webauthn-passwordless", secretData: "{}", credentialData: "{}" },
      ],
    }));
    const facteurs = await m.kc.facteursDe(ID);
    expect(facteurs).toEqual(["otp", "webauthn"]);
    expect(JSON.stringify(facteurs)).not.toMatch(/secretData|credentialData|semence|haché/);
  });
  it("[LOT3-securite] sessionsDe projette des champs fermés : aucune clé ni adresse brute de Keycloak", async () => {
    const m = monter(() => ({ json: [{ id: AUTRE, username: "x", userId: ID, ipAddress: "192.0.2.77", start: 1000, lastAccess: 2000, clients: { console: "console" }, rememberMe: false }] }));
    expect(await m.kc.sessionsDe(ID)).toEqual([{ id: AUTRE, ouverteLe: 1000, derniereActivite: 2000 }]);
  });
});

describe("keycloak-admin : jeton du compte et erreurs", () => {
  it("[LOT3-securite] le jeton est demandé une fois sous promesse partagée, renouvelé avant exp moins 30 s, jamais gardé en échec", async () => {
    const m = monter(() => ({ json: [] }));
    await Promise.all([m.kc.sessionsDe(ID), m.kc.sessionsDe(ID), m.kc.facteursDe(ID)]);
    const jetons = () => m.appels.filter((a) => a.url.includes("/token")).length;
    expect(jetons()).toBe(1);
    const jeton = m.appels.find((a) => a.url.includes("/token"))!;
    expect(new URLSearchParams(jeton.corps).get("grant_type")).toBe("client_credentials");
    expect(new URLSearchParams(jeton.corps).get("client_id")).toBe("console-sessions");
    m.avancer(260_000);
    await m.kc.sessionsDe(ID);
    expect(jetons()).toBe(1);
    m.avancer(15_000);
    await m.kc.sessionsDe(ID);
    expect(jetons()).toBe(2);
  });
  it("[LOT3-securite] le jeton du compte et la réponse de Keycloak ne sortent jamais dans une erreur ni un journal", async () => {
    const m = monter(() => ({ statut: 500, json: { error: "boum", detail: `Bearer ${JETON} ${SECRET} membre@exemple.fr` } }));
    const err = await m.kc.sessionsDe(ID).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ErreurKeycloak);
    expect(err).toMatchObject({ code: "indisponible", statut: 500 });
    const tout = JSON.stringify([String(err), (err as Error).message, (err as Error).stack, Object.entries(err as object), m.journal]);
    for (const interdit of [JETON, SECRET, "membre@exemple.fr", "boum"]) expect(tout).not.toContain(interdit);
    expect(m.journal.length).toBeGreaterThan(0);
  });
  it("[LOT3-securite] Keycloak injoignable ou une réponse mal formée rendent un code fermé sans détail", async () => {
    const coupe = creerKeycloakAdmin({ base: BASE, secrets: new LecteurSecretsMemoire({ KC_SECRET_CONSOLE_SESSIONS: SECRET }), fetch: async () => { throw new Error(`connexion refusée ${SECRET}`); } });
    const err = await coupe.sessionsDe(ID).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "indisponible" });
    expect(JSON.stringify([String(err), (err as Error).stack])).not.toContain(SECRET);
    const louche = monter(() => ({ json: { pas: "une liste" } }));
    await expect(louche.kc.sessionsDe(ID)).rejects.toMatchObject({ code: "reponse_invalide" });
  });
});
