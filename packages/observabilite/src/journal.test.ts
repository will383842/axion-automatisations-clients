import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { creerEnvoiJournal, type FetchJournal } from "./journal.ts";

// Faux collecteur HTTP réel sur 127.0.0.1 (port libre) : il garde le corps BRUT de chaque requête reçue.
// Aucun réseau externe ; entreprises et adresses fictives seulement.
interface FauxCollecteur {
  readonly corps: string[];
  readonly adresses: string[];
  readonly base: string;
  fermer(): Promise<void>;
}
let faux: FauxCollecteur | undefined;
async function demarrer(): Promise<FauxCollecteur> {
  const corps: string[] = [];
  const adresses: string[] = [];
  const serveur: Server = createServer((req, res) => {
    const morceaux: Buffer[] = [];
    req.on("data", (m: Buffer) => morceaux.push(m));
    req.on("end", () => {
      corps.push(Buffer.concat(morceaux).toString("utf8"));
      adresses.push(req.url ?? "");
      res.writeHead(204).end();
    });
  });
  await new Promise<void>((ok) => serveur.listen(0, "127.0.0.1", ok));
  const base = `http://127.0.0.1:${(serveur.address() as AddressInfo).port}`;
  faux = { corps, adresses, base, fermer: () => new Promise<void>((ok) => { serveur.closeAllConnections(); serveur.close(() => ok()); }) };
  return faux;
}
afterEach(async () => { await faux?.fermer(); faux = undefined; });

const lignes = (c: FauxCollecteur) => c.corps.flatMap((b) => b.split("\n").filter(Boolean)).map((l) => JSON.parse(l) as Record<string, unknown>);
// Fetch d'un collecteur injoignable : ne répond jamais, ne rend la main qu'à l'abandon.
const fetchInjoignable: FetchJournal = (_url, init) =>
  new Promise((_ok, ko) => init.signal?.addEventListener("abort", () => ko(new Error("abandon"))));

describe("journal.ts : envoi borné au collecteur", () => {
  it("[A-080] journal.ts n'envoie que la liste fermée de champs (heure, niveau, application, code, message masqué, reqId, tenant)", async () => {
    const c = await demarrer();
    const envoi = creerEnvoiJournal({ url: c.base, application: "api", fetch: fetch as FetchJournal });
    envoi.ecrire({
      heure: "2026-11-07T10:00:00.000Z",
      niveau: "warn",
      code: "ENVOI_REFUSE",
      message: "échec pour Atelier Bertin",
      reqId: "req-1",
      tenant: "tenant-1",
      corps: { iban: "inconnu" },
      authorization: "Basic abcdef123456",
      extra: "libre",
    } as never);
    await envoi.vider();
    const [ligne] = lignes(c);
    expect(Object.keys(ligne ?? {}).sort()).toEqual(["application", "code", "heure", "message", "niveau", "reqId", "tenant"]);
    expect(ligne).toMatchObject({ application: "api", niveau: "warn", code: "ENVOI_REFUSE", reqId: "req-1", tenant: "tenant-1" });
    expect(c.adresses[0]).toMatch(/^\/insert\/jsonline\?/);
    expect(c.adresses[0]).toContain("_msg_field=message");
  });

  it("[C-025] journal.ts masque e-mail, jeton et secret inscrit avant l'envoi", async () => {
    const c = await demarrer();
    const secret = `marqueur-${randomUUID()}`;
    const envoi = creerEnvoiJournal({
      url: c.base,
      application: "executeur",
      fetch: fetch as FetchJournal,
      masquerSecrets: (t) => t.split(secret).join("[masqué]"),
    });
    envoi.ecrire({ message: `contact claire@exemple.fr jeton=abcdef123456 secret ${secret} ${"x".repeat(900)}`, niveau: "info" });
    await envoi.vider();
    const brut = c.corps.join("\n");
    expect(brut).not.toContain("claire@exemple.fr");
    expect(brut).not.toContain("abcdef123456");
    expect(brut).not.toContain(secret);
    expect(String(lignes(c)[0]?.message).length).toBeLessThanOrEqual(500);
  });

  it("[A-080] collecteur injoignable : journal.ts ne bloque pas, garde au plus N lignes et compte les lignes perdues", async () => {
    const envoi = creerEnvoiJournal({ url: "http://victoria-logs:9428", application: "console", fetch: fetchInjoignable, maxLignes: 3, delaiMs: 50 });
    const debut = Date.now();
    for (let i = 0; i < 10; i++) envoi.ecrire({ message: `ligne ${i}`, niveau: "info" });
    expect(Date.now() - debut).toBeLessThan(50);
    expect(envoi.enAttente()).toBeLessThanOrEqual(3);
    expect(envoi.perdues()).toBe(7);
    await envoi.vider();
    expect(envoi.enAttente()).toBe(0);
    expect(envoi.perdues()).toBe(10);
  });

  it("[A-080] sans adresse de collecteur, rien n'est envoyé ni gardé (interrupteur fermé par défaut)", async () => {
    let appels = 0;
    const envoi = creerEnvoiJournal({ application: "api", fetch: async () => { appels++; return { status: 204 }; } });
    envoi.ecrire({ message: "bonjour", niveau: "info" });
    await envoi.vider();
    expect(appels).toBe(0);
    expect(envoi.enAttente()).toBe(0);
    expect(envoi.perdues()).toBe(0);
  });

  it("[LOT5-secret] marqueur unique d'un secret de test absent du faux collecteur", async () => {
    const c = await demarrer();
    const secret = `marqueur-${randomUUID()}`;
    const envoi = creerEnvoiJournal({
      url: c.base,
      application: "api",
      fetch: fetch as FetchJournal,
      masquerSecrets: (t) => t.split(secret).join("[masqué]").split(Buffer.from(secret).toString("base64")).join("[masqué]"),
    });
    envoi.ecrire({ message: `clair ${secret} base64 ${Buffer.from(secret).toString("base64")}`, code: secret, niveau: "error", reqId: "req-2" });
    await envoi.vider();
    const brut = c.corps.join("\n");
    expect(brut).not.toContain(secret);
    expect(brut).not.toContain(Buffer.from(secret).toString("base64"));
    expect(lignes(c)).toHaveLength(1);
  });
});
