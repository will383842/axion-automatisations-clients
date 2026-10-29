import { connect, createServer, type Server, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { demarrerMandataire, type Mandataire } from "./mandataire.ts";

const ouverts: { close: () => unknown }[] = [];
afterEach(() => {
  for (const o of ouverts.splice(0)) o.close();
});

// Un « service distant » d'essai sur la boucle locale : il répond « pong » à ce qu'on lui envoie.
async function serveur(): Promise<{ port: number; srv: Server }> {
  const srv = createServer((s) => s.on("data", () => s.end("pong")));
  ouverts.push(srv);
  await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", ok));
  return { srv, port: (srv.address() as { port: number }).port };
}
async function mandataire(opts: Parameters<typeof demarrerMandataire>[0]): Promise<{ m: Mandataire; port: number }> {
  const m = await demarrerMandataire(opts);
  ouverts.push(m);
  return { m, port: m.port };
}
// Envoie une requête brute au mandataire et rend la première ligne de la réponse (puis le reste lu jusqu'à la fermeture).
function brut(port: number, requete: string, apres?: string): Promise<{ ligne: string; reste: string }> {
  return new Promise((ok) => {
    const s: Socket = connect(port, "127.0.0.1", () => s.write(requete));
    let tampon = "";
    let envoye = false;
    s.on("data", (d) => {
      tampon += d.toString();
      if (apres !== undefined && !envoye && tampon.includes("\r\n\r\n")) {
        envoye = true;
        s.write(apres);
      }
    });
    s.on("close", () => ok({ ligne: tampon.split("\r\n")[0] ?? "", reste: tampon.split("\r\n\r\n")[1] ?? "" }));
    s.on("error", () => undefined);
  });
}

describe("mandataire de sortie", () => {
  it("[A-329] @isolation l'enfant ne joint pas un hôte non déclaré (refus du mandataire)", async () => {
    const { m, port } = await mandataire({ declarees: [{ hote: "api.exemple.test", port: 443 }], resoudre: async () => ["93.184.216.34"] });
    const r = await brut(port, "CONNECT autre.exemple.test:443 HTTP/1.1\r\nHost: autre.exemple.test:443\r\n\r\n");
    expect(r.ligne).toMatch(/^HTTP\/1\.1 403/);
    expect(m.refus()).toEqual({ non_declare: 1 });
  });

  it("[A-329] le mandataire refuse 127.0.0.1, 169.254.169.254 et une adresse privée, même déclarés", async () => {
    const { m, port } = await mandataire({
      declarees: [
        { hote: "127.0.0.1", port: 80 },
        { hote: "169.254.169.254", port: 80 },
        { hote: "10.0.0.5", port: 80 },
      ],
      resoudre: async (h) => [h],
    });
    for (const h of ["127.0.0.1", "169.254.169.254", "10.0.0.5"]) expect((await brut(port, `CONNECT ${h}:80 HTTP/1.1\r\nHost: ${h}:80\r\n\r\n`)).ligne).toMatch(/^HTTP\/1\.1 403/);
    expect(m.refus()).toEqual({ adresse_interdite: 3 });
  });

  it("[A-329] un nom qui se résout vers une adresse privée est refusé (rebinding DNS)", async () => {
    const { m, port } = await mandataire({ declarees: [{ hote: "api.exemple.test", port: 443 }], resoudre: async () => ["192.168.0.10"] });
    expect((await brut(port, "CONNECT api.exemple.test:443 HTTP/1.1\r\nHost: api.exemple.test:443\r\n\r\n")).ligne).toMatch(/^HTTP\/1\.1 403/);
    expect(m.refus()).toEqual({ adresse_interdite: 1 });
  });

  it("[A-329] un hôte déclaré sur un autre port est refusé ; un en-tête Host différent du CONNECT aussi", async () => {
    const { m, port } = await mandataire({ declarees: [{ hote: "api.exemple.test", port: 443 }], resoudre: async () => ["93.184.216.34"] });
    expect((await brut(port, "CONNECT api.exemple.test:8080 HTTP/1.1\r\nHost: api.exemple.test:8080\r\n\r\n")).ligne).toMatch(/^HTTP\/1\.1 403/);
    expect((await brut(port, "CONNECT api.exemple.test:443 HTTP/1.1\r\nHost: autre.exemple.test:443\r\n\r\n")).ligne).toMatch(/^HTTP\/1\.1 403/);
    expect(m.refus()).toEqual({ non_declare: 1, entete_incoherent: 1 });
  });

  it("[A-329] une requête HTTP ordinaire (hors CONNECT) est refusée et comptée", async () => {
    const { m, port } = await mandataire({ declarees: [{ hote: "api.exemple.test", port: 80 }], resoudre: async () => ["93.184.216.34"] });
    expect((await brut(port, "GET http://api.exemple.test/ HTTP/1.1\r\nHost: api.exemple.test\r\n\r\n")).ligne).toMatch(/^HTTP\/1\.1 405/);
    expect(m.refus()).toEqual({ methode: 1 });
  });

  it("[A-329] un hôte déclaré est joint à l'adresse que le mandataire a résolue lui-même (liste du socle de test)", async () => {
    const { port: portDistant } = await serveur();
    const { m, port } = await mandataire({
      declarees: [{ hote: "api.exemple.test", port: portDistant }],
      resoudre: async () => ["127.0.0.1"],
      exceptions: ["127.0.0.1"],
    });
    const r = await brut(port, `CONNECT api.exemple.test:${portDistant} HTTP/1.1\r\nHost: api.exemple.test:${portDistant}\r\n\r\n`, "ping");
    expect(r.ligne).toMatch(/^HTTP\/1\.1 200/);
    expect(r.reste).toBe("pong");
    expect(m.refus()).toEqual({});
  });

  it("[A-329] le compte des refus ne contient aucun contenu : seulement des raisons et des nombres", async () => {
    const { m, port } = await mandataire({ declarees: [], resoudre: async () => [] });
    await brut(port, "CONNECT secret-du-client.exemple.test:443 HTTP/1.1\r\nHost: secret-du-client.exemple.test:443\r\n\r\n");
    expect(JSON.stringify(m.refus())).not.toContain("secret-du-client");
  });
});
