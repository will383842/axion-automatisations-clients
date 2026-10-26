import { createServer, type Server } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ErreurConnecteur, creerJeton } from "@axion-auto/connecteurs-commun";
import { demarrerFauxGraph, type FauxGraph } from "../../harnais/src/faux-graph/serveur.js";
import { creerConnecteurMicrosoft365 } from "./connecteur.ts";

const MAINTENANT = Date.parse("2026-10-26T08:00:00Z");

type Echange = { methode: string; chemin: string; statut?: number; entetes?: Record<string, string>; corps?: unknown; reseau?: boolean };
const fetchRejoue = (echanges: Echange[]): typeof fetch => {
  const file = [...echanges];
  return (async (url: string, init: RequestInit = {}) => {
    const e = file.shift();
    if (!e || e.methode !== (init.method ?? "GET") || !url.startsWith(`http://graph.test/v1.0${e.chemin}`)) throw new Error(`appel hors enregistrement : ${url}`);
    if (e.reseau) throw new TypeError("fetch failed");
    return new Response(e.corps === undefined ? null : JSON.stringify(e.corps), { status: e.statut ?? 200, headers: e.entetes ?? {} });
  }) as never;
};
const jeton = creerJeton("jeton-fictif-verification", MAINTENANT + 3_600_000);
let n = 0;
const message = () => ({ messageId: `<m-${++n}.verif@exemple.fr>`, destinataire: "client@exemple.fr", objet: "Devis", corps: "Bonjour" });

// Mini serveur SMTP local : le faux Graph y dépose ses envois (aucun message ne sort).
function puitSmtp(): Promise<{ serveur: Server; port: number }> {
  const serveur = createServer((s) => {
    let donnees = false;
    s.write("220 puits.test ESMTP\r\n");
    s.on("data", (b) => {
      for (const ligne of b.toString().split("\r\n")) {
        if (donnees) { if (ligne === ".") { donnees = false; s.write("250 ok\r\n"); } continue; }
        if (/^(EHLO|HELO)/i.test(ligne)) s.write("250 puits.test\r\n");
        else if (/^DATA/i.test(ligne)) { donnees = true; s.write("354 go\r\n"); }
        else if (/^QUIT/i.test(ligne)) s.end("221 bye\r\n");
        else if (ligne) s.write("250 ok\r\n");
      }
    });
  });
  return new Promise((ok) => serveur.listen(0, "127.0.0.1", () => ok({ serveur, port: (serveur.address() as { port: number }).port })));
}

let graph: FauxGraph;
let puits: Server;
beforeAll(async () => {
  const p = await puitSmtp();
  puits = p.serveur;
  graph = await demarrerFauxGraph({ mailpit: { smtp: { host: "127.0.0.1", port: p.port } } as never });
});
afterAll(async () => {
  await graph.arreter();
  puits.close();
});
const mode = (m: string, reinitialiser = false) =>
  fetch(`${graph.url}/__controle`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: m, reinitialiser }) });
const connecteur = () => creerConnecteurMicrosoft365({ url: `${graph.url}/v1.0`, maintenant: () => MAINTENANT });

describe("vérification après coup (Graph n'a pas de clé anti-doublon)", () => {
  it("[C-534] @anti-doublon faux Graph en reponse_perdue : verifierApresCoup trouve le message", async () => {
    await mode("reponse_perdue", true);
    const c = connecteur();
    const m = message();
    const e = await c.envoyer(jeton, m).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ErreurConnecteur);
    expect((e as ErreurConnecteur).classe).toBe("passagere");
    expect(await c.verifierApresCoup(jeton, m.messageId)).toBe("trouve");
    expect(await c.verifierApresCoup(jeton, "<jamais-envoye@exemple.fr>")).toBe("absent");
  });

  it("[C-534] Graph muet pendant la vérification : indetermine au délai maximal, jamais absent", async () => {
    const muet = ((_url: string, init: RequestInit = {}) =>
      new Promise((_ok, ko) => init.signal?.addEventListener("abort", () => ko(init.signal?.reason)))) as never;
    const c = creerConnecteurMicrosoft365({ url: "http://graph.test/v1.0", fetch: muet, delaiMs: 20, maintenant: () => MAINTENANT });
    expect(await c.verifierApresCoup(jeton, "<muet@exemple.fr>")).toBe("indetermine");
  });

  it("[C-534] @anti-doublon faux Graph en panne pendant la vérification : indetermine, jamais absent", async () => {
    await mode("reponse_perdue", true);
    const c = connecteur();
    const m = message();
    await c.envoyer(jeton, m).catch(() => undefined);
    await mode("panne_generale");
    expect(await c.verifierApresCoup(jeton, m.messageId)).toBe("indetermine");
    const coupe = creerConnecteurMicrosoft365({ url: "http://graph.test/v1.0", maintenant: () => MAINTENANT, fetch: fetchRejoue([{ methode: "GET", chemin: "/me/mailFolders/SentItems/messages", reseau: true }]) });
    expect(await coupe.verifierApresCoup(jeton, m.messageId)).toBe("indetermine");
  });
});

describe("erreurs de Graph", () => {
  it("[A-275] 429 avec Retry-After donne une erreur quota datée", async () => {
    await mode("quota", true);
    const e = await connecteur().creerBrouillon(jeton, message()).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ErreurConnecteur);
    expect((e as ErreurConnecteur).classe).toBe("quota");
    expect((e as ErreurConnecteur).details.reprise).toBe("2026-10-26T08:00:02.000Z");
    await mode("normal", true);
  });

  it("[A-275] 503 avec Retry-After donne aussi un quota daté, 503 sans date reste passagère", async () => {
    const jetonFictif = creerJeton("jeton-fictif", MAINTENANT + 60_000);
    const avec = creerConnecteurMicrosoft365({ url: "http://graph.test/v1.0", maintenant: () => MAINTENANT, fetch: fetchRejoue([{ methode: "GET", chemin: "/me/messages/m-1", statut: 503, entetes: { "Retry-After": "30" } }]) });
    expect(((await avec.lire(jetonFictif, "m-1", ["objet"]).catch((x: unknown) => x)) as ErreurConnecteur).details.reprise).toBe("2026-10-26T08:00:30.000Z");
    const sans = creerConnecteurMicrosoft365({ url: "http://graph.test/v1.0", maintenant: () => MAINTENANT, fetch: fetchRejoue([{ methode: "GET", chemin: "/me/messages/m-1", statut: 503 }]) });
    expect(((await sans.lire(jetonFictif, "m-1", ["objet"]).catch((x: unknown) => x)) as ErreurConnecteur).classe).toBe("passagere");
  });

  it("[A-388] AADSTS65001 donne identification/consentement_requis", async () => {
    const corps = { error: "invalid_grant", error_description: "AADSTS65001: L'administrateur n'a pas donné son consentement." };
    const c = creerConnecteurMicrosoft365({ url: "http://graph.test/v1.0", maintenant: () => MAINTENANT, fetch: fetchRejoue([{ methode: "GET", chemin: "/me/messages/m-1", statut: 400, corps }]) });
    const e = (await c.lire(creerJeton("jeton-fictif", MAINTENANT + 60_000), "m-1", ["objet"]).catch((x: unknown) => x)) as ErreurConnecteur;
    expect([e.classe, e.code]).toEqual(["identification", "consentement_requis"]);
    const brut = creerConnecteurMicrosoft365({ url: "http://graph.test/v1.0", maintenant: () => MAINTENANT, fetch: fetchRejoue([{ methode: "GET", chemin: "/me/messages/m-1", statut: 400, corps: { error: "invalid_grant" } }]) });
    expect(((await brut.lire(creerJeton("jeton-fictif", MAINTENANT + 60_000), "m-1", ["objet"]).catch((x: unknown) => x)) as ErreurConnecteur).classe).toBe("identification");
  });

  it("[A-275] une autre erreur 4xx est définitive", async () => {
    const c = creerConnecteurMicrosoft365({ url: "http://graph.test/v1.0", maintenant: () => MAINTENANT, fetch: fetchRejoue([{ methode: "GET", chemin: "/me/messages/m-1", statut: 404, corps: { error: { code: "ErrorItemNotFound" } } }]) });
    expect(((await c.lire(creerJeton("jeton-fictif", MAINTENANT + 60_000), "m-1", ["objet"]).catch((x: unknown) => x)) as ErreurConnecteur).classe).toBe("definitive");
  });
});
