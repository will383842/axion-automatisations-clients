import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { demarrerRecepteurs, type Recepteurs } from "./serveur.js";

let r: Recepteurs;
const json = (chemin: string, corps: unknown, methode = "POST") =>
  fetch(`${r.url}${chemin}`, { method: methode, headers: { "content-type": "application/json" }, body: methode === "GET" ? undefined : JSON.stringify(corps) });

beforeAll(async () => {
  r = await demarrerRecepteurs();
});
afterAll(async () => {
  await r.arreter();
});
beforeEach(async () => {
  await fetch(`${r.url}/__recus`, { method: "DELETE" });
});

describe("récepteurs de test", () => {
  it("[C-592] Telegram, MailWizz et un webhook arrivent dans le récepteur de test", async () => {
    expect((await json("/botTEST-NE-PAS-UTILISER-1/sendMessage", { chat_id: 1, text: "Alerte" })).status).toBe(200);
    expect((await json("/api/campaigns", { name: "Relance" })).status).toBe(201);
    expect((await json("/webhook/hub/evenement", { type: "x" })).status).toBe(200);
    const recus = (await (await fetch(`${r.url}/__recus`)).json()) as { canal: string }[];
    expect(recus.map((x) => x.canal)).toEqual(["telegram", "mailwizz", "webhook"]);
  });

  it("[C-592] le récepteur se vide et liste par canal", async () => {
    await json("/webhook/a", { n: 1 });
    await json("/botTEST-NE-PAS-UTILISER-1/sendMessage", { text: "t" });
    expect(((await (await fetch(`${r.url}/__recus?canal=webhook`)).json()) as unknown[]).length).toBe(1);
    await fetch(`${r.url}/__recus`, { method: "DELETE" });
    expect(((await (await fetch(`${r.url}/__recus`)).json()) as unknown[]).length).toBe(0);
  });

  it("[C-592] attaque : route inconnue 404 et rien de rangé ; sendMessage sans texte 400 ; écoute 127.0.0.1", async () => {
    expect((await json("/autre/chose", {})).status).toBe(404);
    expect((await json("/botX/sendMessage", {})).status).toBe(400);
    expect(((await (await fetch(`${r.url}/__recus`)).json()) as unknown[]).length).toBe(0);
    expect(r.adresse).toBe("127.0.0.1");
  });
});
