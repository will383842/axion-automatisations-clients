import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { creerClientMailpit } from "../mailpit.js";
import { demarrerFauxGraph, type FauxGraph } from "./serveur.js";

const mailpit = creerClientMailpit();
// Les tests qui déposent dans Mailpit tournent dans le job « harnais » (service Mailpit) ; ailleurs ils sont sautés.
const itMailpit = process.env["MAILPIT_API"] ? it : it.skip; // fiche: T0-20
let graph: FauxGraph;

const en = (chemin: string, init: RequestInit = {}, compte = "lemoine@exemple.fr") =>
  fetch(`${graph.url}${chemin}`, {
    ...init,
    headers: { authorization: `Bearer faux.${compte}`, "content-type": "application/json", ...init.headers },
  });
const controle = (mode: string, reinitialiser = false) =>
  fetch(`${graph.url}/__controle`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode, reinitialiser }) });
// Les fichiers de test partagent un seul Mailpit : chaque test écrit à une adresse à lui et ne lit que celle-là.
const adresseUnique = () => `${randomUUID()}@exemple.fr`;
async function attendreA(adresse: string, nombre: number) {
  const fin = Date.now() + 10_000;
  for (;;) {
    const trouves = (await mailpit.lister()).filter((m) => m.To.some((a) => a.Address === adresse));
    if (trouves.length >= nombre || Date.now() > fin) return trouves;
    await new Promise((ok) => setTimeout(ok, 100));
  }
}
const brouillon = async (compte?: string, destinataire = "client@exemple.fr") => {
  const r = await en("/v1.0/me/messages", { method: "POST", body: JSON.stringify({ subject: "Devis", body: { contentType: "text", content: "Bonjour" }, toRecipients: [{ emailAddress: { address: destinataire } }] }) }, compte);
  return (await r.json()) as { id: string; internetMessageId: string };
};

beforeAll(async () => {
  if (process.env["MAILPIT_API"]) await mailpit.attendrePret();
  graph = await demarrerFauxGraph({ mailpit });
});
afterAll(async () => {
  await graph.arreter();
});
beforeEach(async () => {
  await controle("normal", true);
});

describe("faux Microsoft 365", () => {
  itMailpit("[C-592] un envoi par le faux Graph arrive dans Mailpit", async () => {
    const dest = adresseUnique();
    const b = await brouillon(undefined, dest);
    const r = await en(`/v1.0/me/messages/${b.id}/send`, { method: "POST" });
    expect(r.status).toBe(202);
    const messages = await attendreA(dest, 1);
    expect(messages[0]?.To.map((a) => a.Address)).toEqual([dest]);
    expect(messages[0]?.Subject).toBe("Devis");
  });

  itMailpit("[C-534] mode reponse_perdue : le client reçoit une erreur réseau ET le message est dans Mailpit et dans Éléments envoyés", async () => {
    await controle("reponse_perdue");
    const dest = adresseUnique();
    const b = await brouillon(undefined, dest);
    await expect(en(`/v1.0/me/messages/${b.id}/send`, { method: "POST" })).rejects.toThrow();
    expect(await attendreA(dest, 1)).toHaveLength(1);
    await controle("normal");
    const filtre = encodeURIComponent(`internetMessageId eq '${b.internetMessageId}'`);
    const envoyes = (await (await en(`/v1.0/me/mailFolders/SentItems/messages?$filter=${filtre}`)).json()) as { value: unknown[] };
    expect(envoyes.value).toHaveLength(1);
  });

  itMailpit("[C-534] deux envois du même brouillon donnent deux messages (aucun anti-doublon côté Graph)", async () => {
    const dest = adresseUnique();
    const b = await brouillon(undefined, dest);
    await en(`/v1.0/me/messages/${b.id}/send`, { method: "POST", headers: { "client-request-id": "meme-cle" } });
    await en(`/v1.0/me/messages/${b.id}/send`, { method: "POST", headers: { "client-request-id": "meme-cle" } });
    expect(await attendreA(dest, 2)).toHaveLength(2);
  });

  it("[C-603] panne_generale : 503 sur deux comptes différents", async () => {
    await controle("panne_generale");
    const a = await en("/v1.0/me/messages", { method: "POST", body: "{}" }, "lemoine@exemple.fr");
    const b = await en("/v1.0/me/messages", { method: "POST", body: "{}" }, "marceau@exemple.fr");
    expect([a.status, b.status]).toEqual([503, 503]);
  });

  it("[C-603] quota : 429 avec Retry-After", async () => {
    await controle("quota");
    const r = await en("/v1.0/me/messages", { method: "POST", body: "{}" });
    expect(r.status).toBe(429);
    expect(Number(r.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("[C-592] le jeton est factice, et le mode consentement exigé répond AADSTS65001", async () => {
    const ok = await fetch(`${graph.url}/oauth2/v2.0/token`, { method: "POST", body: new URLSearchParams({ client_id: "lemoine@exemple.fr", grant_type: "client_credentials" }) });
    expect(ok.status).toBe(200);
    await controle("consentement_admin_requis");
    const ko = await fetch(`${graph.url}/oauth2/v2.0/token`, { method: "POST", body: new URLSearchParams({ client_id: "lemoine@exemple.fr" }) });
    expect(ko.status).toBe(400);
    expect(JSON.stringify(await ko.json())).toContain("AADSTS65001");
  });

  it("[LOT0-harnais] un destinataire hors @exemple.fr et *.test est refusé", async () => {
    const r = await en("/v1.0/me/messages", { method: "POST", body: JSON.stringify({ subject: "x", toRecipients: [{ emailAddress: { address: "quelquun" + "@example.com" } }] }) });
    expect(r.status).toBe(400);
  });

  it("[LOT0-harnais] le faux serveur n'écoute que sur 127.0.0.1", () => {
    expect(graph.adresse).toBe("127.0.0.1");
  });

  it("[LOT0-harnais] /__controle refusé si NODE_ENV=production", async () => {
    const avant = process.env["NODE_ENV"];
    process.env["NODE_ENV"] = "production";
    try {
      expect((await controle("panne_generale")).status).toBe(403);
    } finally {
      process.env["NODE_ENV"] = avant;
    }
  });

  it("[C-592] faux Graph : consentement exigé (AADSTS65001), puis accordé par /adminconsent, puis jeton délivré", async () => {
    await fetch(`${graph.url}/__controle`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "normal", consentement_requis: true }) });
    const jeton = (tenant: string) =>
      fetch(`${graph.url}/${tenant}/oauth2/v2.0/token`, { method: "POST", body: new URLSearchParams({ client_id: "appli-test", grant_type: "client_credentials" }) });
    const avant = await jeton("atelier-bertin.test");
    expect(avant.status).toBe(400);
    expect(JSON.stringify(await avant.json())).toContain("AADSTS65001");
    const accord = await fetch(`${graph.url}/adminconsent?client_id=appli-test&tenant=atelier-bertin.test`);
    expect(accord.status).toBe(200);
    expect((await jeton("atelier-bertin.test")).status).toBe(200);
    // Le consentement est PAR locataire : un autre locataire reste refusé.
    expect((await jeton("garage-fontaine.test")).status).toBe(400);
  });

  it("[C-592] faux Graph : mauvais compte Microsoft (mode mauvais_compte) et /adminconsent sans paramètres", async () => {
    expect((await fetch(`${graph.url}/adminconsent?client_id=appli-test`)).status).toBe(400);
    await controle("mauvais_compte");
    const r = await fetch(`${graph.url}/atelier-bertin.test/oauth2/v2.0/token`, { method: "POST", body: new URLSearchParams({ client_id: "appli-test" }) });
    expect(r.status).toBe(400);
    expect(JSON.stringify(await r.json())).toContain("AADSTS50020");
    await controle("normal");
    expect((await fetch(`${graph.url}/atelier-bertin.test/oauth2/v2.0/token`, { method: "POST", body: new URLSearchParams({ client_id: "appli-test" }) })).status).toBe(200);
  });

  it("[C-592] faux Graph : le locataire se compare sans tenir compte de la casse (comme Azure)", async () => {
    await fetch(`${graph.url}/__controle`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "normal", consentement_requis: true }) });
    await fetch(`${graph.url}/adminconsent?client_id=appli-test&tenant=Atelier-Bertin.test`);
    const jeton = await fetch(`${graph.url}/atelier-bertin.TEST/oauth2/v2.0/token`, { method: "POST", body: new URLSearchParams({ client_id: "appli-test" }) });
    expect(jeton.status).toBe(200);
  });

  it("[C-592] attaque : le chemin encodé n'évite pas les pannes de /v1.0", async () => {
    await controle("panne_generale");
    expect((await en("/%76%31.0/me/messages", { method: "POST", body: "{}" })).status).toBe(503);
    await controle("quota");
    expect((await en("/%76%31.0/me/messages", { method: "POST", body: "{}" })).status).toBe(429);
  });

  it("[C-592] attaque : /adminconsent est refusé hors NODE_ENV=test", async () => {
    const avant = process.env["NODE_ENV"];
    process.env["NODE_ENV"] = "production";
    try {
      expect((await fetch(`${graph.url}/adminconsent?client_id=appli-test&tenant=a.test`)).status).toBe(403);
    } finally {
      process.env["NODE_ENV"] = avant;
    }
  });
});
