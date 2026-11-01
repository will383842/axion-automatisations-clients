import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { emettreJeton } from "../../../../packages/contrats/src/c6/jeton.js";
import { LIMITES_DEBIT } from "../../../../packages/contrats/src/commun/debit.js";
import type { CleEchange } from "../coffre/cles-echanges.js";
import { alertesEnMemoire } from "../alertes/port.js";
import { construireServeur } from "../serveur.js";
import { routeEntree, type DepsEntree } from "../routes/entree.js";

const MAINTENANT = 1_792_800_000;
const EMAIL = "equipe@exemple.fr";
const CHEMIN = "/api/console/v1/entree";
const CLE = { kid: "c6-essai-a", secret: randomBytes(32) };
// Clé d'un autre canal (c1) : même kid annoncé, autre secret.
const AUTRE_CANAL = { kid: CLE.kid, secret: randomBytes(32) };
const secretDe = (c: CleEchange) => c.secret.toString("base64");
const jetonDe = (cle = CLE, email = EMAIL, iat = MAINTENANT) => emettreJeton(secretDe(cle), cle.kid, email, iat);

// Mémoire en processus : SET NX, INCR et EXPIRE comme Valkey. `panne` simule Valkey arrêté.
function memoireFausse() {
  const valeurs = new Map<string, string>();
  const ttl = new Map<string, number>();
  const etat = { panne: false };
  const garde = () => { if (etat.panne) throw new Error("Valkey arrêté"); };
  return {
    etat,
    valeurs,
    ttl,
    async set(cle: string, valeur: string, _ex?: string, secondes?: number) { garde(); if (valeurs.has(cle)) return null; valeurs.set(cle, valeur); ttl.set(cle, secondes ?? 0); return "OK" as const; },
    async incr(cle: string) { garde(); const n = Number(valeurs.get(cle) ?? "0") + 1; valeurs.set(cle, String(n)); return n; },
  };
}

function monter(options: { memoire?: ReturnType<typeof memoireFausse>; cles?: CleEchange[] | "panne"; lignes?: string[]; attentes?: number[] } = {}) {
  const memoire = options.memoire ?? memoireFausse();
  const alertes = alertesEnMemoire();
  const lignes = options.lignes ?? [];
  const serveur = construireServeur({ journal: { write: (l: string) => lignes.push(l) } });
  const deps: DepsEntree = {
    cles: { clesAcceptees: async (canal) => { if (options.cles === "panne") throw new Error("coffre indisponible"); return canal === "c6" ? (options.cles ?? [CLE]) : []; } },
    memoire,
    alertes,
    keycloak: { autorisation: "https://sso.exemple.test/realms/equipe/protocol/openid-connect/auth", clientId: "console", redirectUri: "https://console.exemple.test/api/auth/retour" },
    connexionNormale: "/connexion",
    maintenant: () => MAINTENANT,
    attendre: async (ms) => { options.attentes?.push(ms); },
  };
  routeEntree(serveur, deps);
  return { serveur, memoire, alertes, lignes };
}
const poster = (serveur: ReturnType<typeof monter>["serveur"], corps: unknown, extra: { url?: string; ip?: string; type?: string } = {}) =>
  serveur.inject({ method: "POST", url: extra.url ?? CHEMIN, remoteAddress: extra.ip ?? "192.0.2.10", headers: { "content-type": extra.type ?? "application/json" }, payload: typeof corps === "string" ? corps : JSON.stringify(corps) });

describe("réception du lien signé C6", () => {
  it("[C-404] un lien signé valide est reçu et renvoie vers la connexion Keycloak avec login_hint et double facteur exigé", async () => {
    const { serveur } = monter();
    const r = await poster(serveur, { jeton: jetonDe() });
    expect(r.statusCode).toBe(200);
    const url = new URL((r.json() as { url: string }).url);
    expect(url.origin + url.pathname).toBe("https://sso.exemple.test/realms/equipe/protocol/openid-connect/auth");
    expect(Object.fromEntries(url.searchParams)).toEqual({ client_id: "console", redirect_uri: "https://console.exemple.test/api/auth/retour", response_type: "code", scope: "openid", login_hint: EMAIL, prompt: "login", acr_values: "mfa" });
    await serveur.close();
  });

  it("[C-404] @isolation le succès ne pose aucune session ni cookie", async () => {
    const { serveur } = monter();
    const r = await poster(serveur, { jeton: jetonDe() });
    expect(r.statusCode).toBe(200);
    expect(r.headers["set-cookie"]).toBeUndefined();
    expect(r.headers["authorization"]).toBeUndefined();
    expect(Object.keys(r.json() as object)).toEqual(["url"]);
    expect(r.headers["cache-control"]).toBe("no-store");
    await serveur.close();
  });

  it("[C-404] un jeton déjà utilisé est refusé (rejeu dans les 2 minutes)", async () => {
    const { serveur, memoire } = monter();
    const jeton = jetonDe();
    const un = await poster(serveur, { jeton });
    const deux = await poster(serveur, { jeton });
    expect((un.json() as { url: string }).url).toContain("login_hint");
    expect(deux.json()).toEqual({ url: "/connexion" });
    const cle = [...memoire.valeurs.keys()].find((k) => k.startsWith("entree-jti:"));
    expect(cle).toMatch(/^entree-jti:[0-9a-f-]{36}$/);
    await serveur.close();
  });

  it("[C-404] deux usages simultanés du même jeton : un seul passe", async () => {
    const { serveur } = monter();
    const jeton = jetonDe();
    const rs = await Promise.all(Array.from({ length: 5 }, () => poster(serveur, { jeton })));
    expect(rs.filter((r) => (r.json() as { url: string }).url.includes("login_hint"))).toHaveLength(1);
    await serveur.close();
  });

  it("[C-404] un jeton de 61 s est refusé, 60 s accepté", async () => {
    const { serveur } = monter();
    const ancien = jetonDe(CLE, EMAIL, MAINTENANT - 61);
    expect((await poster(serveur, { jeton: ancien })).json()).toEqual({ url: "/connexion" });
    const limite = jetonDe(CLE, EMAIL, MAINTENANT - 60);
    expect((await poster(serveur, { jeton: limite })).json()).toHaveProperty("url", expect.stringContaining("login_hint"));
    await serveur.close();
  });

  it("[C-404] iat dans le futur de plus de 5 s, exp absent et version 2 sont refusés", async () => {
    const { serveur } = monter();
    expect((await poster(serveur, { jeton: jetonDe(CLE, EMAIL, MAINTENANT + 6) })).json()).toEqual({ url: "/connexion" });
    // Chaque charge est signée avec la bonne clé : seul le contenu (exp absent, version 2) peut faire refuser le jeton.
    const signe = (charge: object) => {
      const b = Buffer.from(JSON.stringify(charge)).toString("base64url");
      return `${b}.${createHmac("sha256", secretDe(CLE)).update(b).digest("base64url")}`;
    };
    const base = { v: 1, kid: CLE.kid, jti: randomUUID(), email: EMAIL, iat: MAINTENANT };
    // Témoin : la même charge, avec exp et version 1, signée de la même façon, est acceptée.
    expect((await poster(serveur, { jeton: signe({ ...base, exp: MAINTENANT + 60 }) })).json()).toHaveProperty("url", expect.stringContaining("login_hint"));
    for (const j of [signe({ ...base, jti: randomUUID() }), signe({ ...base, jti: randomUUID(), exp: MAINTENANT + 60, v: 2 })]) expect((await poster(serveur, { jeton: j })).json()).toEqual({ url: "/connexion" });
    await serveur.close();
  });

  // Une clé retirée du coffre n'est pas renvoyée par clesAcceptees (c'est ce filtre qui la retire) : ici, seul un kid inconnu de la réception est essayé.
  it("[C-404] un jeton signé avec une autre clé est refusé (autre canal, kid inconnu, signature tronquée)", async () => {
    const { serveur } = monter();
    const bon = jetonDe();
    const cas = [
      jetonDe(AUTRE_CANAL),
      emettreJeton(secretDe(CLE), "c6-inconnue", EMAIL, MAINTENANT),
      emettreJeton(secretDe({ kid: CLE.kid, secret: randomBytes(32) }), CLE.kid, EMAIL, MAINTENANT),
      bon.slice(0, -5),
      // kid d'un autre canal, bien signé avec la clé de ce canal.
      (() => {
        const c = Buffer.from(JSON.stringify({ v: 1, kid: "c1-essai-a", jti: randomUUID(), email: EMAIL, iat: MAINTENANT, exp: MAINTENANT + 60 })).toString("base64url");
        return `${c}.${createHmac("sha256", secretDe(AUTRE_CANAL)).update(c).digest("base64url")}`;
      })(),
    ];
    for (const j of cas) expect((await poster(serveur, { jeton: j })).json()).toEqual({ url: "/connexion" });
    await serveur.close();
  });

  it("[C-404] toutes les erreurs donnent la même réponse", async () => {
    const jeton = jetonDe();
    const vus = memoireFausse();
    const attentes: number[] = [];
    const causes: Record<string, () => Promise<{ statusCode: number; body: string; headers: Record<string, unknown> }>> = {
      signature: async () => poster(monter({ attentes }).serveur, { jeton: jetonDe(AUTRE_CANAL) }),
      duree: async () => poster(monter({ attentes }).serveur, { jeton: jetonDe(CLE, EMAIL, MAINTENANT - 61) }),
      rejeu: async () => { const m = monter({ memoire: vus, attentes }); await poster(m.serveur, { jeton }); return poster(m.serveur, { jeton }); },
      version: async () => {
        const b = Buffer.from(JSON.stringify({ v: 2, kid: CLE.kid, jti: randomUUID(), email: EMAIL, iat: MAINTENANT, exp: MAINTENANT + 60 })).toString("base64url");
        return poster(monter({ attentes }).serveur, { jeton: `${b}.${createHmac("sha256", secretDe(CLE)).update(b).digest("base64url")}` });
      },
      forme_vide: async () => poster(monter({ attentes }).serveur, { jeton: "" }),
      forme: async () => poster(monter({ attentes }).serveur, "pas du json", {}),
      type: async () => poster(monter({ attentes }).serveur, { jeton: 42 }),
      corps_absent: async () => poster(monter({ attentes }).serveur, "", { type: "text/plain" }),
      valkey: async () => { const m = memoireFausse(); m.etat.panne = true; return poster(monter({ memoire: m, attentes }).serveur, { jeton: jetonDe() }); },
      cles: async () => poster(monter({ cles: "panne", attentes }).serveur, { jeton: jetonDe() }),
      requete: async () => poster(monter({ attentes }).serveur, { jeton: jetonDe() }, { url: `${CHEMIN}?j=${jetonDe()}` }),
    };
    const reponses: Record<string, string> = {};
    for (const [nom, f] of Object.entries(causes)) {
      const r = await f();
      reponses[nom] = JSON.stringify([r.statusCode, r.body, r.headers["content-type"], r.headers["cache-control"], r.headers["set-cookie"]]);
    }
    expect(new Set(Object.values(reponses)).size, JSON.stringify(reponses)).toBe(1);
    expect(JSON.parse(Object.values(reponses)[0] as string)[1]).toBe(JSON.stringify({ url: "/connexion" }));
    // Même temps de réponse : chaque requête attend le même plancher, quelle que soit la cause.
    expect(attentes.length).toBeGreaterThanOrEqual(Object.keys(causes).length);
    expect(new Set(attentes).size).toBe(1);
  });

  it("[C-404] un jeton posé dans la requête (?j=) est refusé et n'entre dans aucun journal", async () => {
    const lignes: string[] = [];
    const { serveur } = monter({ lignes });
    const jeton = jetonDe();
    const r = await serveur.inject({ method: "POST", url: `${CHEMIN}?j=${jeton}`, headers: { "content-type": "application/json" }, payload: "{}" });
    expect(r.json()).toEqual({ url: "/connexion" });
    const g = await serveur.inject({ method: "GET", url: `${CHEMIN}?j=${jeton}` });
    expect(g.statusCode).toBeGreaterThanOrEqual(400);
    expect(lignes.join("\n")).not.toContain(jeton.split(".")[0]);
    // Un jeton valide dans le corps n'est pas non plus accepté s'il arrive avec une requête dans l'adresse.
    expect((await poster(serveur, { jeton: jetonDe() }, { url: `${CHEMIN}?j=x` })).json()).toEqual({ url: "/connexion" });
    await serveur.close();
  });

  it("[C-404] le jeton n'apparaît dans aucun journal", async () => {
    const lignes: string[] = [];
    const { serveur } = monter({ lignes });
    const bon = jetonDe();
    const mauvais = jetonDe(AUTRE_CANAL);
    await poster(serveur, { jeton: bon });
    await poster(serveur, { jeton: bon });
    await poster(serveur, { jeton: mauvais });
    const m = memoireFausse(); m.etat.panne = true;
    const m2 = monter({ memoire: m, lignes });
    await poster(m2.serveur, { jeton: jetonDe() });
    const journal = lignes.join("\n");
    expect(journal).not.toBe("");
    for (const j of [bon, mauvais]) for (const morceau of j.split(".")) expect(journal).not.toContain(morceau);
    expect(journal).not.toContain(EMAIL);
    expect(journal).not.toContain("192.0.2.10");
    // Le détail est un code seulement.
    expect(journal).toMatch(/"code":"(rejeu|jeton_invalide|memoire_indisponible)"/);
    await serveur.close();
    await m2.serveur.close();
  });

  it("[C-404] Valkey arrêté : le lien est refusé", async () => {
    const memoire = memoireFausse();
    memoire.etat.panne = true;
    const { serveur } = monter({ memoire });
    const r = await poster(serveur, { jeton: jetonDe() });
    expect(r.json()).toEqual({ url: "/connexion" });
    await serveur.close();
  });

  it("[C-404] les clés illisibles ou absentes : le lien est refusé", async () => {
    for (const cles of ["panne", []] as const) {
      const { serveur } = monter({ cles: cles as never });
      expect((await poster(serveur, { jeton: jetonDe() })).json()).toEqual({ url: "/connexion" });
      await serveur.close();
    }
  });

  it("[C-404] e-mail piégé : jamais d'injection dans l'URL, e-mail transmis tel quel après validation", async () => {
    const { serveur } = monter();
    // Bien signés avec la bonne clé : seul le contrôle de forme de l'e-mail peut les refuser.
    const signeAvec = (email: string) => {
      const c = Buffer.from(JSON.stringify({ v: 1, kid: CLE.kid, jti: randomUUID(), email, iat: MAINTENANT, exp: MAINTENANT + 60 })).toString("base64url");
      return `${c}.${createHmac("sha256", secretDe(CLE)).update(c).digest("base64url")}`;
    };
    for (const piege of ["a@exemple.fr&prompt=none", 'a"@exemple.fr', "a b@exemple.fr", "a@exemple.fr\r\nLocation: https://autre.test", "a@exemple.fr\u202e"]) {
      const j = signeAvec(piege);
      expect((await poster(serveur, { jeton: j })).json(), piege).toEqual({ url: "/connexion" });
    }
    const r = await poster(serveur, { jeton: jetonDe(CLE, "Prénom.Nom+test@Exemple.fr") });
    const url = new URL((r.json() as { url: string }).url);
    expect(url.searchParams.get("login_hint")).toBe("Prénom.Nom+test@Exemple.fr");
    expect(url.searchParams.getAll("prompt")).toEqual(["login"]);
    await serveur.close();
  });

  it("[C-404] aucun paramètre de retour n'est lu : pas de redirection ouverte", async () => {
    const { serveur } = monter();
    const r = await poster(serveur, { jeton: jetonDe(), retour: "https://autre.test/vol", redirect_uri: "https://autre.test", prompt: "none", acr_values: "0", login_hint: "x@autre.test" });
    const url = new URL((r.json() as { url: string }).url);
    expect(url.searchParams.get("redirect_uri")).toBe("https://console.exemple.test/api/auth/retour");
    expect(url.searchParams.get("prompt")).toBe("login");
    expect(url.searchParams.get("acr_values")).toBe("mfa");
    expect(url.searchParams.get("login_hint")).toBe(EMAIL);
    expect(r.body).not.toContain("autre.test");
    await serveur.close();
  });

  it("[C-404] le jti n'est consommé qu'après une vérification réussie", async () => {
    const { serveur, memoire } = monter();
    await poster(serveur, { jeton: jetonDe(AUTRE_CANAL) });
    await poster(serveur, { jeton: jetonDe(CLE, EMAIL, MAINTENANT - 61) });
    expect([...memoire.valeurs.keys()].filter((k) => k.startsWith("entree-jti:"))).toEqual([]);
    await serveur.close();
  });

  it("[C-404] limite : 10 essais par minute et par adresse, puis 429 ; alerte après 10 refus", async () => {
    const { serveur, alertes } = monter();
    for (let i = 0; i < 10; i++) expect((await poster(serveur, { jeton: jetonDe(AUTRE_CANAL) })).statusCode).toBe(200);
    const trop = await poster(serveur, { jeton: jetonDe() });
    expect(trop.statusCode).toBe(429);
    expect((trop.json() as { erreur: { code: string } }).erreur.code).toBe("debit_depasse");
    // Retry-After obligatoire (contrat commun/debit.ts) : entier de 1 à 60.
    const attente = Number(trop.headers["retry-after"]);
    expect(Number.isInteger(attente) && attente >= 1 && attente <= 60, String(trop.headers["retry-after"])).toBe(true);
    // Une autre adresse n'est pas touchée.
    expect((await poster(serveur, { jeton: jetonDe() }, { ip: "192.0.2.11" })).statusCode).toBe(200);
    expect(alertes.envoyees).toHaveLength(1);
    // Pas de nouvelle alerte à chaque refus de la même minute.
    await poster(serveur, { jeton: jetonDe() });
    expect(alertes.envoyees).toHaveLength(1);
    await serveur.close();
  });

  it("[C-404] sous la limite et sans refus, aucune alerte", async () => {
    const { serveur, alertes } = monter();
    for (let i = 0; i < 9; i++) await poster(serveur, { jeton: jetonDe() });
    expect(alertes.envoyees).toHaveLength(0);
    await serveur.close();
  });

  it("[C-404] chaque compteur de limite et de refus a une durée de vie dès sa création (écriture atomique)", async () => {
    const { serveur, memoire } = monter();
    await poster(serveur, { jeton: jetonDe(AUTRE_CANAL) });
    const compteurs = [...memoire.valeurs.keys()].filter((k) => k.startsWith("entree-limite:") || k.startsWith("entree-refus:"));
    expect(compteurs).toHaveLength(2);
    for (const k of compteurs) expect(memoire.ttl.get(k), k).toBeGreaterThan(0);
    await serveur.close();
  });

  it("[C-404] seul application/json est lu : une requête « simple » (text/plain, formulaire) est refusée sans consommer le jeton", async () => {
    const { serveur, memoire } = monter();
    const jeton = jetonDe();
    for (const type of ["text/plain", "application/x-www-form-urlencoded", "text/plain;charset=UTF-8"]) {
      const r = await poster(serveur, { jeton }, { type });
      expect(r.json(), type).toEqual({ url: "/connexion" });
    }
    expect([...memoire.valeurs.keys()].filter((k) => k.startsWith("entree-jti:"))).toEqual([]);
    expect((await poster(serveur, { jeton })).json()).toHaveProperty("url", expect.stringContaining("login_hint"));
    await serveur.close();
  });

  it("[C-404] la limite et le seuil d'alerte sont lus dans le contrat C6, pas recopiés", () => {
    const source = readFileSync(fileURLToPath(new URL("./c6.ts", import.meta.url)), "utf8");
    expect(source).toContain("LIMITES_DEBIT.c6");
    expect(source).not.toMatch(/(ESSAIS_PAR_MINUTE|REFUS_AVANT_ALERTE)\s*=\s*\d/);
    expect(LIMITES_DEBIT.c6.parMinute).toBe(10);
  });
});
