import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { creerClientMailpit } from "../mailpit.js";
import { demarrerFauxGmail, type FauxGmail } from "./serveur.js";

const mailpit = creerClientMailpit();
const itMailpit = process.env["MAILPIT_API"] ? it : it.skip; // fiche: T0-20
let gmail: FauxGmail;

const rfc822 = (id: string) =>
  Buffer.from(`Message-ID: <${id}>\r\nFrom: lemoine@exemple.fr\r\nTo: client@exemple.fr\r\nSubject: Devis\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nBonjour`).toString("base64url");
const envoyer = (id: string, jeton = "faux.lemoine@exemple.fr") =>
  fetch(`${gmail.url}/gmail/v1/users/me/messages/send`, {
    method: "POST",
    headers: { authorization: `Bearer ${jeton}`, "content-type": "application/json" },
    body: JSON.stringify({ raw: rfc822(id) }),
  });
const controle = (mode: string, reinitialiser = false) =>
  fetch(`${gmail.url}/__controle`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode, reinitialiser }) });

beforeAll(async () => {
  if (process.env["MAILPIT_API"]) await mailpit.attendrePret();
  gmail = await demarrerFauxGmail({ mailpit });
});
afterAll(async () => {
  await gmail.arreter();
});
beforeEach(async () => {
  if (process.env["MAILPIT_API"]) await mailpit.vider();
  await controle("normal", true);
});

describe("faux Gmail", () => {
  itMailpit("[C-592] un envoi par le faux Gmail arrive dans Mailpit et porte le libellé SENT", async () => {
    const r = await envoyer("a1@faux-gmail.test");
    expect(r.status).toBe(200);
    expect(((await r.json()) as { labelIds: string[] }).labelIds).toContain("SENT");
    const messages = await mailpit.attendreMessages(1);
    expect(messages[0]?.To.map((a) => a.Address)).toEqual(["client@exemple.fr"]);
    const q = encodeURIComponent("rfc822msgid:a1@faux-gmail.test");
    const liste = (await (await fetch(`${gmail.url}/gmail/v1/users/me/messages?q=${q}`, { headers: { authorization: "Bearer faux.lemoine@exemple.fr" } })).json()) as { messages?: unknown[] };
    expect(liste.messages).toHaveLength(1);
  });

  itMailpit("[C-592] faux Gmail en reponse_perdue : erreur réseau côté client ET message présent dans Mailpit", async () => {
    await controle("reponse_perdue");
    await expect(envoyer("b1@faux-gmail.test")).rejects.toThrow();
    expect(await mailpit.attendreMessages(1)).toHaveLength(1);
  });

  itMailpit("[C-592] deux envois identiques par le faux Gmail donnent deux messages (aucune clé anti-doublon)", async () => {
    await envoyer("c1@faux-gmail.test");
    await envoyer("c1@faux-gmail.test");
    expect(await mailpit.attendreMessages(2)).toHaveLength(2);
  });

  it("[C-592] faux Gmail en quota : 429 avec Retry-After", async () => {
    await controle("quota");
    const r = await envoyer("d1@faux-gmail.test");
    expect(r.status).toBe(429);
    expect(Number(r.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("[C-592] faux Gmail : panne_generale 503, acces_refuse 403 (application bloquée)", async () => {
    await controle("panne_generale");
    expect((await envoyer("e1@faux-gmail.test")).status).toBe(503);
    await controle("acces_refuse");
    const r = await envoyer("e2@faux-gmail.test");
    expect(r.status).toBe(403);
    expect(JSON.stringify(await r.json())).toContain("accessNotConfigured");
  });

  it("[C-592] attaque : sans jeton factice, 401 ; message sans raw ou destinataire réel, 400 ; mode inconnu, 400", async () => {
    expect((await envoyer("f1@faux-gmail.test", "vrai-jeton")).status).toBe(401);
    const sansRaw = await fetch(`${gmail.url}/gmail/v1/users/me/messages/send`, { method: "POST", headers: { authorization: "Bearer faux.lemoine@exemple.fr", "content-type": "application/json" }, body: "{}" });
    expect(sansRaw.status).toBe(400);
    const reel = Buffer.from(`From: lemoine@exemple.fr\r\nTo: ${["quelquun", "autre.com"].join("@")}\r\nSubject: x\r\n\r\ny`).toString("base64url");
    const r = await fetch(`${gmail.url}/gmail/v1/users/me/messages/send`, { method: "POST", headers: { authorization: "Bearer faux.lemoine@exemple.fr", "content-type": "application/json" }, body: JSON.stringify({ raw: reel }) });
    expect(r.status).toBe(400);
    expect((await controle("n_importe_quoi")).status).toBe(400);
  });

  it("[C-592] attaque : /__controle refusé si NODE_ENV=production, serveur sur 127.0.0.1", async () => {
    expect(gmail.adresse).toBe("127.0.0.1");
    const avant = process.env["NODE_ENV"];
    process.env["NODE_ENV"] = "production";
    try {
      expect((await controle("panne_generale")).status).toBe(403);
    } finally {
      process.env["NODE_ENV"] = avant;
    }
  });
});
