import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ErreurConnecteur, creerJeton, ficheConnexion } from "@axion-auto/connecteurs-commun";
import { lancer } from "@axion-auto/connecteurs-commun/src/suite/lanceur.ts";
import type { Banc, Fabrique, Scenario } from "@axion-auto/connecteurs-commun/src/suite/messagerie.ts";
import { creerConnecteurGmail, ouvrirGmail } from "./connecteur.ts";

const BASE = "http://gmail.test";
const P = "/gmail/v1/users/me";
const MAINTENANT = Date.parse("2026-10-26T08:00:00Z");
const jeton = () => creerJeton("jeton-fictif", MAINTENANT + 60_000);

type Echange = { methode: string; chemin: string; statut?: number; entetes?: Record<string, string>; corps?: unknown; reseau?: boolean };
type Vu = { methode: string; url: string; corps: string | undefined };

// Rejoue les réponses enregistrées dans l'ordre : un appel hors ordre ou en trop échoue.
function fetchRejoue(echanges: Echange[], vus: Vu[] = []): typeof fetch {
  const file = [...echanges];
  return (async (url: string, init: RequestInit = {}) => {
    const methode = init.method ?? "GET";
    vus.push({ methode, url, corps: init.body as string | undefined });
    const e = file.shift();
    if (!e || e.methode !== methode || !url.startsWith(`${BASE}${e.chemin}`)) throw new Error(`appel hors enregistrement : ${methode} ${url}`);
    if (e.reseau) throw new TypeError("fetch failed");
    return new Response(e.corps === undefined ? null : JSON.stringify(e.corps), { status: e.statut ?? 200, headers: e.entetes ?? {} });
  }) as never;
}
const avec = (echanges: Echange[], vus: Vu[] = [], options: object = {}) =>
  creerConnecteurGmail({ url: BASE, maintenant: () => MAINTENANT, fetch: fetchRejoue(echanges, vus), ...options });
const g = (chemin: string, corps: unknown, statut = 200, entetes?: Record<string, string>): Echange => ({ methode: "GET", chemin: P + chemin, statut, corps, ...(entetes ? { entetes } : {}) });
const message = (messageId = "<m-1.essai@exemple.fr>") => ({ messageId, destinataire: "client@exemple.fr", objet: "Essai", corps: "Bonjour" });

const fabriqueEnregistree: Fabrique = (s: Scenario): Banc => {
  const chemin = fileURLToPath(new URL(`../enregistrements/${s.nom}.json`, import.meta.url));
  const { echanges } = JSON.parse(readFileSync(chemin, "utf8")) as { echanges: Echange[] };
  const vus: Vu[] = [];
  const valeurJeton = `jeton-fictif-${s.nom}`;
  const connecteur = creerConnecteurGmail({ url: BASE, fetch: fetchRejoue(echanges, vus), maintenant: () => MAINTENANT });
  return { connecteur, jeton: creerJeton(valeurJeton, MAINTENANT + 60_000), valeurJeton, envoyes: () => vus.filter((v) => v.url.endsWith("/send")).length };
};

describe("connecteur Gmail sur réponses enregistrées", () => {
  it("[A-405] le connecteur Gmail passe la suite messagerie sur enregistrements", async () => {
    const reseau = globalThis.fetch;
    globalThis.fetch = (() => { throw new Error("réseau interdit"); }) as never;
    try {
      await lancer(fabriqueEnregistree);
    } finally {
      globalThis.fetch = reseau;
    }
  });

  it("[A-386] l'envoi pose le Message-ID et l'en-tête d'intention dans le message RFC 2822 en base64url", async () => {
    const vus: Vu[] = [];
    const c = avec([{ methode: "POST", chemin: `${P}/messages/send`, corps: { id: "e-1" } }], vus);
    await c.envoyer(jeton(), { ...message(), objet: "Devis été", corps: "Bonjour é" });
    const raw = (JSON.parse(vus[0]?.corps ?? "{}") as { raw: string }).raw;
    expect(raw).toMatch(/^[A-Za-z0-9_-]+$/);
    const texte = Buffer.from(raw, "base64url").toString("utf8");
    expect(texte).toContain("Message-ID: <m-1.essai@exemple.fr>\r\n");
    expect(texte).toContain("X-Axion-Intention: <m-1.essai@exemple.fr>\r\n");
    expect(texte).toContain("To: client@exemple.fr\r\n");
    expect(texte).toContain("Subject: =?UTF-8?B?");
    expect(Buffer.from(texte.split("\r\n\r\n")[1] ?? "", "base64").toString("utf8")).toBe("Bonjour é");
  });

  it("[A-386] un objet ou un destinataire avec saut de ligne est refusé avant tout appel", async () => {
    const vus: Vu[] = [];
    const c = avec([], vus);
    for (const m of [{ ...message(), objet: "Essai\r\nBcc: autre@exemple.fr" }, { ...message(), destinataire: "client@exemple.fr\r\nBcc: autre@exemple.fr" }, { ...message(), destinataire: "pas une adresse" }]) {
      const e = await c.envoyer(jeton(), m).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(ErreurConnecteur);
      expect((e as ErreurConnecteur).classe).toBe("definitive");
    }
    expect(vus).toEqual([]);
  });

  it("[A-386] le connecteur est fermé par défaut, exige GMAIL_URL et son propre interrupteur", () => {
    const ouvert = { CONNECTEURS_MESSAGERIE_OUVERT: "1", CONNECTEUR_GMAIL_OUVERT: "1", GMAIL_URL: BASE };
    expect(() => ouvrirGmail({})).toThrow(/fermé/);
    expect(() => ouvrirGmail({ ...ouvert, CONNECTEUR_GMAIL_OUVERT: "false" })).toThrow(/fermé/);
    expect(() => ouvrirGmail({ ...ouvert, CONNECTEURS_MESSAGERIE_OUVERT: undefined })).toThrow(/fermé/);
    expect(() => ouvrirGmail({ ...ouvert, GMAIL_URL: " " })).toThrow(/GMAIL_URL/);
    expect(ouvrirGmail(ouvert).declaration.capacites.find((x) => x.action === "envoyer")?.garantie).toBe("verifiable_apres_coup");
  });

  it("[A-386] les portées demandées sont les plus étroites pour le module d'exemple", () => {
    const demande = (actions: string[], portees: string[]) => ({ connecteurs: [{ famille: "messagerie", actions, portees }] });
    const sansEtiquette = demande(["lister_nouveaux", "lire", "creer_brouillon", "envoyer"], ["gmail.readonly", "gmail.compose"]);
    const lecture = creerConnecteurGmail({ url: BASE, actions: sansEtiquette.connecteurs[0]!.actions });
    expect(lecture.declaration.portees).toEqual(["gmail.readonly", "gmail.compose"]);
    const fiche = ficheConnexion(sansEtiquette, [lecture.declaration]).connexions[0]!;
    expect(fiche.portees).toEqual(["gmail.readonly", "gmail.compose"]);
    expect(fiche.porteesInutiles).toEqual([]);
    const avecEtiquette = creerConnecteurGmail({ url: BASE, actions: ["lire", "etiqueter"] });
    expect(avecEtiquette.declaration.portees).toEqual(["gmail.modify"]);
  });

  it("[A-406] aucun corps de message dans les journaux du connecteur (marqueur unique)", async () => {
    const MARQUEUR = "CORPS-UNIQUE-7f3a91";
    const lignes: string[] = [];
    const corps = Buffer.from(MARQUEUR).toString("base64url");
    const c = avec([
      { methode: "POST", chemin: `${P}/messages/send`, statut: 400, corps: { error: { code: 400, message: MARQUEUR } } },
      g("/messages/m-1", { id: "m-1", payload: { mimeType: "text/plain", body: { data: corps } } }),
    ], [], { journal: (l: string) => lignes.push(l) });
    await c.envoyer(jeton(), { ...message("<m-2.essai@exemple.fr>"), corps: MARQUEUR }).catch(() => undefined);
    expect((await c.lire(jeton(), "m-1", ["corps"])).corps).toBe(MARQUEUR);
    expect(lignes.length).toBeGreaterThan(0);
    expect(lignes.join("\n")).not.toContain(MARQUEUR);
  });

  it("[A-386] le corps lu est le text/plain décodé d'un message à plusieurs parties", async () => {
    const data = (t: string) => Buffer.from(t).toString("base64url");
    const c = avec([g("/messages/m-1", { id: "m-1", payload: { mimeType: "multipart/alternative", parts: [{ mimeType: "text/html", body: { data: data("<p>x</p>") } }, { mimeType: "text/plain", body: { data: data("Bonjour é") } }] } })]);
    expect((await c.lire(jeton(), "m-1", ["corps"])).corps).toBe("Bonjour é");
  });

  it("[A-386] le curseur de la liste complète devient celui de history.list, et un curseur illisible est refusé", async () => {
    const vus: Vu[] = [];
    const c = avec([
      g("/profile", { historyId: "100" }), g("/messages", { messages: [{ id: "m-1" }] }),
      g("/history", { history: [{ messagesAdded: [{ message: { id: "m-2" } }, { message: { id: "m-2" } }] }, { messagesAdded: [{ message: { id: "m-3" } }] }], historyId: "120" }),
    ], vus);
    expect(await c.listerNouveaux(jeton(), null)).toEqual({ ids: ["m-1"], suivant: null });
    expect(c.curseurHistorique()).toBe("h:100");
    expect(await c.listerNouveaux(jeton(), "h:100")).toEqual({ ids: ["m-2", "m-3"], suivant: null });
    expect(c.curseurHistorique()).toBe("h:120");
    expect(vus[2]?.url).toContain("startHistoryId=100");
    for (const mauvais of ["h:abc", "l:a&b", "x:1", "h:1:a/b"]) {
      expect(((await c.listerNouveaux(jeton(), mauvais).catch((x: unknown) => x)) as ErreurConnecteur).code).toBe("curseur_invalide");
    }
  });

  it("[A-386] history.list en 404 (historyId trop vieux) : liste complète sans redonner les messages déjà traités", async () => {
    const c = avec([
      g("/profile", { historyId: "100" }), g("/messages", { messages: [{ id: "m-1" }, { id: "m-2" }] }),
      g("/history", { error: { code: 404 } }, 404),
      g("/profile", { historyId: "300" }), g("/messages", { messages: [{ id: "m-1" }, { id: "m-2" }, { id: "m-3" }] }),
    ]);
    await c.listerNouveaux(jeton(), null);
    expect((await c.listerNouveaux(jeton(), "h:100")).ids).toEqual(["m-3"]);
    expect(c.curseurHistorique()).toBe("h:300");
  });

  it("[A-275] un Gmail muet est coupé au délai maximal : erreur passagère, jamais un blocage", async () => {
    const muet = ((_url: string, init: RequestInit = {}) => new Promise((_ok, ko) => init.signal?.addEventListener("abort", () => ko(init.signal?.reason)))) as never;
    const c = creerConnecteurGmail({ url: BASE, fetch: muet, delaiMs: 20, maintenant: () => MAINTENANT });
    const e = await c.lire(jeton(), "m-1", ["objet"]).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ErreurConnecteur);
    expect((e as ErreurConnecteur).classe).toBe("passagere");
  });
});

describe("erreurs de l'API Gmail", () => {
  const erreur = async (statut: number, corps: unknown, entetes?: Record<string, string>) =>
    (await avec([g("/messages/m-1", corps, statut, entetes)]).lire(jeton(), "m-1", ["objet"]).catch((x: unknown) => x)) as ErreurConnecteur;

  it("[A-386] 429 avec Retry-After, ou 403 rateLimitExceeded, donnent une erreur quota datée", async () => {
    const a = await erreur(429, { error: { code: 429 } }, { "Retry-After": "30" });
    expect([a.classe, a.details.reprise]).toEqual(["quota", "2026-10-26T08:00:30.000Z"]);
    const b = await erreur(403, { error: { code: 403, errors: [{ reason: "rateLimitExceeded" }] } });
    expect([b.classe, b.details.reprise]).toEqual(["quota", "2026-10-26T08:01:00.000Z"]);
  });

  it("[A-386] 401 et invalid_grant donnent identification ; admin_policy_enforced donne application_bloquee_par_administrateur", async () => {
    expect((await erreur(401, {})).classe).toBe("identification");
    expect((await erreur(400, { error: "invalid_grant" })).classe).toBe("identification");
    const e = await erreur(400, { error: "admin_policy_enforced" });
    expect([e.classe, e.code]).toEqual(["identification", "application_bloquee_par_administrateur"]);
  });

  it("[A-386] 5xx est passagère et une autre 4xx est définitive", async () => {
    expect((await erreur(500, {})).classe).toBe("passagere");
    expect((await erreur(404, { error: { code: 404 } })).classe).toBe("definitive");
  });
});
