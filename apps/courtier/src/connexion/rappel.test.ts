import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { demarrerFauxGraph, type FauxGraph } from "../../../../packages/harnais/src/faux-graph/serveur.ts";
import { creerJournal } from "../journal.js";
import { signerLien, type CleLien } from "./lien.js";
import { demarrerAutorisation, terminerRappel, type PortsRappel } from "./rappel.js";
import { creerTransactionsMemoire } from "./transactions.js";

// Attaques prévues (audit) : fixation de session OAuth (state d'un autre client, rappel rejoué, autre session) ; redirection ouverte ;
// compte d'un autre locataire ; lien transmis à un tiers ; course sur le lien ; fuite d'un jeton ; texte d'erreur du fournisseur.
const T0 = 1_800_000_000_000;
const T = "11111111-1111-4111-8111-111111111111";
const AUTRE_T = "99999999-9999-4999-8999-999999999999";
const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const LOC = "22222222-2222-4222-8222-222222222222";
const SESSION = { sujet: "personne-portail-1", tenantId: T };
const CLE: CleLien = { kid: "k1", secret: randomBytes(32) };
const MARQUE_ACCES = "marqueur-acces-8e31c0";
const MARQUE_RENOUV = "marqueur-renouvellement-2b7d4f";
const MARQUE_TEXTE = "MARQUEUR-TEXTE-DU-FOURNISSEUR-61";

let graph: FauxGraph;
beforeAll(async () => { graph = await demarrerFauxGraph(); });
afterAll(async () => { await graph.arreter(); });

const idToken = (p: object) => `${Buffer.from("{}").toString("base64url")}.${Buffer.from(JSON.stringify(p)).toString("base64url")}.sig`;
const lienMs = (sur: object = {}) => signerLien({ v: 1, jti: randomUUID(), t: T, c: C, o: "microsoft-365", l: LOC, iat: T0 / 1000, exp: T0 / 1000 + 3600, ...sur }, CLE);
const etatDe = (adresse: string) => new URL(adresse).searchParams.get("state") as string;

type Passerelle = { fetch: typeof fetch; appels: string[] };
// Faux fournisseur écrit à la main : jeton, id_token et lecture sans effet. `jeton` pilote la réponse du point de jeton.
function passerelle(jeton: () => Response | Promise<Response>, lecture: () => Response | Promise<Response> = () => new Response("{}", { status: 200 })): Passerelle {
  const appels: string[] = [];
  const f = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    appels.push(`${init?.method ?? "GET"} ${u}`);
    return /\/token$/.test(u) ? jeton() : lecture();
  }) as typeof fetch;
  return { fetch: f, appels };
}
const jetonOk = (p: object = { tid: LOC, oid: "oid-1", preferred_username: "lemoine@exemple.fr" }) => () => new Response(JSON.stringify({ token_type: "Bearer", expires_in: 3599, access_token: MARQUE_ACCES, refresh_token: MARQUE_RENOUV, id_token: idToken(p) }), { status: 200 });

function monde(sur: Partial<PortsRappel> = {}, fournisseur: Passerelle = passerelle(jetonOk())) {
  const base = { etat: "a_tester", dernierTest: null as number | null, etats: [] as string[], coffre: [] as { chemin: string; valeur: unknown }[], lignes: [] as string[], reclamations: 0 };
  const p: PortsRappel = {
    cles: () => [CLE],
    maintenant: () => T0,
    porte: () => true,
    connexionATester: async () => base.etat === "a_tester" && base.dernierTest === null,
    transactions: creerTransactionsMemoire({ maintenant: () => T0 }),
    fetch: fournisseur.fetch,
    microsoft: { clientId: "app-axion@exemple.fr", redirectUri: "https://portail.exemple.fr/connexion/retour", portees: ["Mail.ReadWrite", "Mail.Send"], secretApplication: async () => "secret-application-fictif", hote: "https://login.test", hoteApi: "https://graph.test" },
    google: { redirectUri: "https://portail.exemple.fr/connexion/retour", portees: ["https://mail.google.com/"] },
    lireApplication: async () => ({ client_id: "id-app-interne", client_secret: "marqueur-secret-application-99" }),
    reclamer: async () => { if (base.etat !== "a_tester" || base.dernierTest !== null) return false; base.dernierTest = T0; base.reclamations++; return true; },
    ecrireCoffre: async (chemin, valeur) => { base.coffre.push({ chemin, valeur }); },
    marquerEtat: async (_t, _c, etat, code) => { base.etat = etat; base.etats.push(`${etat}:${code ?? ""}`); },
    journal: creerJournal((l) => base.lignes.push(l)),
    ...sur,
  };
  const tout = () => JSON.stringify(base);
  return { p, base, fournisseur, tout };
}
const ouvrir = async (m: ReturnType<typeof monde>, lien = lienMs()) => {
  const r = await demarrerAutorisation(m.p, lien, SESSION);
  if (!r.ok) throw new Error(`ouverture refusée : ${r.code}`);
  return etatDe(r.adresse);
};
const aucunJeton = (m: ReturnType<typeof monde>, ...reponses: unknown[]) => {
  const tous = m.tout() + JSON.stringify(reponses);
  expect(tous).not.toContain(MARQUE_ACCES);
  expect(tous).not.toContain(MARQUE_RENOUV);
};

describe("lien ouvert, transactions et porte", () => {
  it("[B-092] lien ouvert sans session du portail, ou par la session d'un autre client : refus neutre, aucune transaction créée", async () => {
    const m = monde();
    const sansSession = await demarrerAutorisation(m.p, lienMs(), null);
    const autreClient = await demarrerAutorisation(m.p, lienMs(), { sujet: "personne-2", tenantId: AUTRE_T });
    const lienFaux = await demarrerAutorisation(m.p, `${lienMs()}x`, SESSION);
    expect(sansSession).toEqual({ ok: false, code: "lien_invalide" });
    expect(autreClient).toEqual(sansSession);
    expect(lienFaux).toEqual(sansSession);
    expect(m.p.transactions.taille()).toBe(0);
  });

  it("[B-092] outil dont la porte est fermée (interrupteur ou fiche de conformité non signée) : refus porte_fermee", async () => {
    const m = monde({ porte: (outil) => outil !== "microsoft-365" });
    expect(await demarrerAutorisation(m.p, lienMs(), SESSION)).toEqual({ ok: false, code: "porte_fermee" });
    expect(m.p.transactions.taille()).toBe(0);
    const ferme = monde({ porte: () => false });
    expect(await demarrerAutorisation(ferme.p, lienMs(), SESSION)).toEqual({ ok: false, code: "porte_fermee" });
  });
});

describe("rappel OAuth", () => {
  it("[B-092] les jetons reçus vont au coffre : ni la base, ni la réponse, ni le journal n'en contiennent (marqueur unique)", async () => {
    const m = monde();
    const state = await ouvrir(m);
    const rep = await terminerRappel(m.p, SESSION, { state, code: "code-fictif" });
    expect(rep).toEqual({ etat: "active" });
    const jetons = m.base.coffre.find((e) => e.chemin === `clients/${T}/connexions/${C}/jetons`);
    expect(jetons?.valeur).toMatchObject({ access_token: MARQUE_ACCES, refresh_token: MARQUE_RENOUV, duree_s: 3599 });
    expect(Object.keys(jetons?.valeur as object).sort()).toEqual(["access_token", "duree_s", "expires_at", "refresh_token"]);
    expect(m.base.coffre.find((e) => e.chemin === `clients/${T}/connexions/${C}/compte`)?.valeur).toMatchObject({ fournisseur: "microsoft", tid: LOC });
    const horsCoffre = JSON.stringify({ ...m.base, coffre: [] });
    expect(horsCoffre + JSON.stringify(rep)).not.toContain(MARQUE_ACCES);
    expect(horsCoffre + JSON.stringify(rep)).not.toContain(MARQUE_RENOUV);
    expect(m.base.lignes.join("")).toContain("connexion_reliee");
  });

  it("[B-092] le lien ne sert qu'une fois : après une connexion réussie, le même lien est refusé", async () => {
    const m = monde();
    const lien = lienMs();
    const state = await ouvrir(m, lien);
    expect(await terminerRappel(m.p, SESSION, { state, code: "c" })).toEqual({ etat: "active" });
    expect(await demarrerAutorisation(m.p, lien, SESSION)).toEqual({ ok: false, code: "lien_invalide" });
  });

  it("[B-092] deux rappels en parallèle pour la même connexion : une seule écriture au coffre, l'autre rend deja_utilise", async () => {
    const m = monde();
    const lien = lienMs();
    const [s1, s2] = [await ouvrir(m, lien), await ouvrir(m, lien)];
    const rendus = await Promise.all([terminerRappel(m.p, SESSION, { state: s1, code: "c1" }), terminerRappel(m.p, SESSION, { state: s2, code: "c2" })]);
    expect(rendus.map((r) => r.etat).sort()).toEqual(["active", "refuse"]);
    expect(rendus.find((r) => r.etat === "refuse")).toMatchObject({ code: "deja_utilise" });
    expect(m.base.coffre.filter((e) => e.chemin.endsWith("/jetons"))).toHaveLength(1);
    expect(m.base.reclamations).toBe(1);
    aucunJeton(m, rendus);
  });

  it("[A-388] AADSTS65001 mène à l'accord de l'administrateur puis à une connexion verte (faux Graph)", async () => {
    await fetch(`${graph.url}/__controle`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "normal", reinitialiser: true, consentement_requis: true }) });
    // Le faux ne rend pas de refresh_token : on l'ajoute au retour, comme le vrai fournisseur avec offline_access.
    const reel: typeof fetch = async (url, init) => {
      const r = await fetch(url, init);
      if (!String(url).endsWith("/token") || !r.ok) return r;
      return new Response(JSON.stringify({ ...((await r.json()) as object), refresh_token: MARQUE_RENOUV }), { status: 200 });
    };
    const m = monde({ fetch: reel, microsoft: { clientId: "app-axion@exemple.fr", redirectUri: "https://portail.exemple.fr/connexion/retour", portees: ["Mail.ReadWrite"], secretApplication: async () => "secret-application-fictif", hote: graph.url, hoteApi: graph.url } });
    const s1 = await ouvrir(m);
    const admin = await terminerRappel(m.p, SESSION, { state: s1, code: "code-fictif" });
    expect(admin).toMatchObject({ etat: "suite", code: "accord_admin_requis" });
    const adresse = new URL((admin as { adresse: string }).adresse);
    expect(adresse.pathname).toBe(`/${LOC}/v2.0/adminconsent`);
    expect(m.base.etat).toBe("a_tester");
    // L'administrateur du client donne son accord (simulation du faux), puis revient avec le locataire.
    await fetch(`${graph.url}/adminconsent?client_id=app-axion@exemple.fr&tenant=${LOC}`);
    const retour = await terminerRappel(m.p, SESSION, { state: etatDe(adresse.toString()), tenant: LOC, admin_consent: "True" });
    expect(retour).toMatchObject({ etat: "suite", code: "accord_admin_donne" });
    const fin = await terminerRappel(m.p, SESSION, { state: etatDe((retour as { adresse: string }).adresse), code: "code-fictif-2" });
    expect(fin).toEqual({ etat: "active" });
    expect(m.base.etat).toBe("active");
    expect(m.base.coffre.find((e) => e.chemin.endsWith("/compte"))?.valeur).toMatchObject({ tid: LOC });
  });

  it("[A-388] state modifié, inconnu ou déjà utilisé : refus, aucun appel au fournisseur", async () => {
    const m = monde();
    const state = await ouvrir(m);
    const modifie = `${state.slice(0, -1)}${state.endsWith("A") ? "B" : "A"}`;
    for (const mauvais of [modifie, "inconnu", "", undefined]) {
      expect(await terminerRappel(m.p, SESSION, { ...(mauvais === undefined ? {} : { state: mauvais }), code: "c" })).toEqual({ etat: "refuse", code: "etat_inconnu" });
    }
    expect(m.fournisseur.appels).toHaveLength(0);
    expect(await terminerRappel(m.p, SESSION, { state, code: "c" })).toEqual({ etat: "active" });
    const appels = m.fournisseur.appels.length;
    expect(await terminerRappel(m.p, SESSION, { state, code: "c" })).toEqual({ etat: "refuse", code: "etat_inconnu" });
    expect(m.fournisseur.appels).toHaveLength(appels);
  });

  it("[A-388] locataire reçu différent du locataire attendu, ou id_token sans tid : mauvais_compte, rien au coffre", async () => {
    for (const charge of [{ tid: AUTRE_T, oid: "o" }, { oid: "o" }, { tid: LOC.toUpperCase().replace(/2/g, "3"), oid: "o" }]) {
      const m = monde({}, passerelle(jetonOk(charge)));
      const rep = await terminerRappel(m.p, SESSION, { state: await ouvrir(m), code: "c" });
      expect(rep).toEqual({ etat: "refuse", code: "mauvais_compte" });
      expect(m.base.coffre).toHaveLength(0);
      expect(m.base.dernierTest).toBeNull();
      aucunJeton(m, rep);
    }
    const sansId = monde({}, passerelle(() => new Response(JSON.stringify({ access_token: MARQUE_ACCES, refresh_token: MARQUE_RENOUV, expires_in: 3600 }), { status: 200 })));
    expect(await terminerRappel(sansId.p, SESSION, { state: await ouvrir(sansId), code: "c" })).toEqual({ etat: "refuse", code: "mauvais_compte" });
    expect(sansId.base.coffre).toHaveLength(0);
  });

  it("[A-388] rappel ouvert dans une autre session du portail : refus, la transaction est brûlée", async () => {
    const m = monde();
    const state = await ouvrir(m);
    for (const intruse of [{ sujet: "personne-2", tenantId: T }, { sujet: SESSION.sujet, tenantId: AUTRE_T }, null]) {
      const s = await ouvrir(m);
      expect(await terminerRappel(m.p, intruse, { state: s, code: "c" })).toEqual({ etat: "refuse", code: "autre_session" });
      expect(await terminerRappel(m.p, SESSION, { state: s, code: "c" })).toEqual({ etat: "refuse", code: "etat_inconnu" });
    }
    expect(m.fournisseur.appels).toHaveLength(0);
    expect(await terminerRappel(m.p, SESSION, { state, code: "c" })).toEqual({ etat: "active" });
  });

  it("[A-388] le texte d'erreur du fournisseur n'est jamais recopié : codes fermés dans la réponse et le journal", async () => {
    const refus = passerelle(() => new Response(JSON.stringify({ error: "invalid_grant", error_description: `AADSTS70000: ${MARQUE_TEXTE}` }), { status: 400 }));
    const a = monde({}, refus);
    const repA = await terminerRappel(a.p, SESSION, { state: await ouvrir(a), code: "c" });
    expect(repA).toEqual({ etat: "refuse", code: "refus_fournisseur" });
    const b = monde();
    const repB = await terminerRappel(b.p, SESSION, { state: await ouvrir(b), error: "access_denied", error_description: MARQUE_TEXTE } as never);
    expect(repB).toEqual({ etat: "refuse", code: "refus_fournisseur" });
    const panne = monde({}, passerelle(() => new Response(`<html>${MARQUE_TEXTE}</html>`, { status: 503 })));
    const repC = await terminerRappel(panne.p, SESSION, { state: await ouvrir(panne), code: "c" });
    expect(repC).toEqual({ etat: "refuse", code: "fournisseur_indisponible" });
    for (const [mo, rep] of [[a, repA], [b, repB], [panne, repC]] as const) {
      expect(mo.tout() + JSON.stringify(rep)).not.toContain(MARQUE_TEXTE);
      expect(mo.base.lignes.join("")).toContain("connexion_refusee");
    }
  });

  it("[A-385] la connexion est testée aussitôt (lecture sans effet) et son état enregistré : verte", async () => {
    await fetch(`${graph.url}/__controle`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "normal", reinitialiser: true }) });
    const vus: string[] = [];
    const reel: typeof fetch = async (url, init) => {
      vus.push(`${init?.method ?? "GET"} ${new URL(String(url)).pathname}`);
      const r = await fetch(url, init);
      if (!String(url).endsWith("/token") || !r.ok) return r;
      return new Response(JSON.stringify({ ...((await r.json()) as object), refresh_token: MARQUE_RENOUV }), { status: 200 });
    };
    const m = monde({ fetch: reel, microsoft: { clientId: "lemoine@exemple.fr", redirectUri: "https://portail.exemple.fr/connexion/retour", portees: ["Mail.ReadWrite"], secretApplication: async () => "secret-application-fictif", hote: graph.url, hoteApi: graph.url } });
    expect(await terminerRappel(m.p, SESSION, { state: await ouvrir(m), code: "c" })).toEqual({ etat: "active" });
    expect(vus.filter((v) => v.startsWith("GET") && v.includes("/v1.0/me/mailFolders/SentItems/messages"))).toHaveLength(1);
    expect(vus.filter((v) => v.startsWith("POST") && !v.endsWith("/token"))).toHaveLength(0);
    expect(m.base.etats).toEqual(["active:"]);
  });

  it("[A-385] test refusé (401 ou 403) ou trop long : état en_echec avec son code, aucune valeur journalisée", async () => {
    const cas: [() => Response | Promise<Response>, string][] = [
      [() => new Response("{}", { status: 401 }), "refuse_401"],
      [() => new Response("{}", { status: 403 }), "refuse_403"],
      [() => new Promise<Response>(() => undefined), "delai"],
    ];
    for (const [lecture, code] of cas) {
      const m = monde({ delaiTestMs: 20 }, passerelle(jetonOk(), lecture));
      const rep = await terminerRappel(m.p, SESSION, { state: await ouvrir(m), code: "c" });
      expect(rep).toEqual({ etat: "en_echec", code });
      expect(m.base.etats).toEqual([`en_echec:${code}`]);
      aucunJeton({ ...m, tout: () => JSON.stringify({ ...m.base, coffre: [] }) }, rep);
    }
  });

  it("[B-092] Google interne : application lue par le port, secret jamais dans la réponse ni le journal, parcours jusqu'à la connexion verte", async () => {
    const lecteurs: string[] = [];
    const google = passerelle(() => new Response(JSON.stringify({ access_token: MARQUE_ACCES, refresh_token: MARQUE_RENOUV, expires_in: 3600, id_token: idToken({ sub: "s1", email: "x@atelier-bertin.test", hd: "atelier-bertin.test" }) }), { status: 200 }));
    const m = monde({ lireApplication: async (t, c) => { lecteurs.push(`${t}:${c}`); return { client_id: "id-app-interne", client_secret: "marqueur-secret-application-99" }; } }, google);
    const lien = signerLien({ v: 1, jti: randomUUID(), t: T, c: C, o: "gmail", d: "atelier-bertin.test", iat: T0 / 1000, exp: T0 / 1000 + 3600 }, CLE);
    const ouverture = await demarrerAutorisation(m.p, lien, SESSION);
    expect(ouverture.ok && new URL(ouverture.adresse).origin).toBe("https://accounts.google.com");
    expect(lecteurs).toEqual([`${T}:${C}`]);
    const rep = await terminerRappel(m.p, SESSION, { state: etatDe((ouverture as { adresse: string }).adresse), code: "c" });
    expect(rep).toEqual({ etat: "active" });
    expect(m.base.coffre.some((e) => e.chemin.endsWith("/application"))).toBe(false);
    const dehors = JSON.stringify({ ...m.base, coffre: [] }) + JSON.stringify(rep) + (ouverture.ok ? ouverture.adresse : "");
    expect(dehors).not.toContain("marqueur-secret-application-99");
  });
});
