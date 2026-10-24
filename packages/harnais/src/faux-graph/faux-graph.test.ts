import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { creerClientMailpit } from "../mailpit.ts";
import { demarrerFauxGraph, type FauxGraph } from "./serveur.ts";

const mailpit = creerClientMailpit();
let graph: FauxGraph;

const en = (chemin: string, init: RequestInit = {}, compte = "lemoine@exemple.fr") =>
  fetch(`${graph.url}${chemin}`, {
    ...init,
    headers: { authorization: `Bearer faux.${compte}`, "content-type": "application/json", ...init.headers },
  });
const controle = (mode: string) => fetch(`${graph.url}/__controle`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode }) });
const brouillon = async (compte?: string) => {
  const r = await en("/v1.0/me/messages", { method: "POST", body: JSON.stringify({ subject: "Devis", body: { contentType: "text", content: "Bonjour" }, toRecipients: [{ emailAddress: { address: "client@exemple.fr" } }] }) }, compte);
  return (await r.json()) as { id: string; internetMessageId: string };
};

beforeAll(async () => {
  await mailpit.attendrePret();
  graph = await demarrerFauxGraph({ mailpit });
});
afterAll(async () => {
  await graph.arreter();
});
beforeEach(async () => {
  await mailpit.vider();
  await controle("normal");
});

describe("faux Microsoft 365", () => {
  it("[C-592] un envoi par le faux Graph arrive dans Mailpit", async () => {
    const b = await brouillon();
    const r = await en(`/v1.0/me/messages/${b.id}/send`, { method: "POST" });
    expect(r.status).toBe(202);
    const messages = await mailpit.attendreMessages(1);
    expect(messages[0]?.To.map((a) => a.Address)).toEqual(["client@exemple.fr"]);
    expect(messages[0]?.Subject).toBe("Devis");
  });

  it("[C-534] mode reponse_perdue : le client reçoit une erreur réseau ET le message est dans Mailpit et dans Éléments envoyés", async () => {
    await controle("reponse_perdue");
    const b = await brouillon();
    await expect(en(`/v1.0/me/messages/${b.id}/send`, { method: "POST" })).rejects.toThrow();
    expect(await mailpit.attendreMessages(1)).toHaveLength(1);
    await controle("normal");
    const filtre = encodeURIComponent(`internetMessageId eq '${b.internetMessageId}'`);
    const envoyes = (await (await en(`/v1.0/me/mailFolders/SentItems/messages?$filter=${filtre}`)).json()) as { value: unknown[] };
    expect(envoyes.value).toHaveLength(1);
  });

  it("[C-534] deux envois du même brouillon donnent deux messages (aucun anti-doublon côté Graph)", async () => {
    const b = await brouillon();
    await en(`/v1.0/me/messages/${b.id}/send`, { method: "POST", headers: { "client-request-id": "meme-cle" } });
    await en(`/v1.0/me/messages/${b.id}/send`, { method: "POST", headers: { "client-request-id": "meme-cle" } });
    expect(await mailpit.attendreMessages(2)).toHaveLength(2);
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
    const r = await en("/v1.0/me/messages", { method: "POST", body: JSON.stringify({ subject: "x", toRecipients: [{ emailAddress: { address: "quelquun@autre.com" } }] }) });
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
});
