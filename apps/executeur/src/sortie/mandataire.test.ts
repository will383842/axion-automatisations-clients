import { connect, createServer, Socket, type Server } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { demarrerMandataire, type Mandataire } from "./mandataire.ts";

const ouverts: { close: () => unknown }[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
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

  // Les délais de socket de Node n'obéissent pas aux horloges simulées : on relève les délais demandés, puis on les fait « expirer ».
  function espionnerDelais(surReglage?: (s: Socket, ms: number) => void): { socket: Socket; ms: number }[] {
    const reglages: { socket: Socket; ms: number }[] = [];
    const reel = Socket.prototype.setTimeout;
    vi.spyOn(Socket.prototype, "setTimeout").mockImplementation(function (this: Socket, ms: number, cb?: () => void) {
      reglages.push({ socket: this, ms });
      surReglage?.(this, ms);
      return reel.call(this, ms, cb);
    });
    return reglages;
  }
  async function amontSilencieux(): Promise<{ port: number; fermetures: () => number; connexions: () => number }> {
    let fermees = 0;
    let recues = 0;
    const srv = createServer((s) => {
      recues++;
      s.on("close", () => fermees++);
      s.on("error", () => undefined);
    });
    ouverts.push(srv);
    await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", ok));
    return { port: (srv.address() as { port: number }).port, fermetures: () => fermees, connexions: () => recues };
  }
  const attendre = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
  const requeteConnect = (p: number) => `CONNECT api.exemple.test:${p} HTTP/1.1\r\nHost: api.exemple.test:${p}\r\n\r\n`;

  // Le client part pendant la résolution ; on attend la fermeture côté serveur (événement close), puis on libère la résolution.
  async function clientPartiPendantResolution(adresse: string): Promise<{ amont: Awaited<ReturnType<typeof amontSilencieux>>; m: Mandataire }> {
    const amont = await amontSilencieux();
    const reglages = espionnerDelais();
    let liberer: (a: string[]) => void = () => undefined;
    let demarree = false;
    const { m, port } = await mandataire({
      declarees: [{ hote: "api.exemple.test", port: amont.port }],
      resoudre: () => new Promise<string[]>((ok) => { demarree = true; liberer = ok; }),
      exceptions: ["127.0.0.1"],
    });
    const s: Socket = connect(port, "127.0.0.1", () => s.write(requeteConnect(amont.port)));
    s.on("error", () => undefined);
    while (!demarree) await attendre(5);
    const cote = reglages.find((x) => x.ms === 10_000 && !x.socket.connecting)?.socket;
    expect(cote).toBeDefined();
    const serveurFerme = new Promise<void>((ok) => cote?.once("close", () => ok()));
    s.destroy();
    await serveurFerme;
    liberer([adresse]);
    await attendre(150);
    return { amont, m };
  }

  it("[A-329] un client parti pendant une résolution DNS lente n'ouvre aucune connexion amont", async () => {
    const { amont } = await clientPartiPendantResolution("127.0.0.1");
    expect(amont.connexions()).toBe(0);
  });

  it("[A-329] client parti pendant la résolution et adresse interdite : le refus est quand même compté", async () => {
    const { amont, m } = await clientPartiPendantResolution("10.0.0.5");
    expect(amont.connexions()).toBe(0);
    expect(m.refus()).toEqual({ adresse_interdite: 1 });
  });

  it("[A-329] après l'expiration des 10 s pendant la résolution DNS, la libération de la résolution n'ouvre aucune connexion amont et le client a reçu 504", async () => {
    const amont = await amontSilencieux();
    const reglages = espionnerDelais();
    let liberer: (a: string[]) => void = () => undefined;
    let demarree = false;
    const { port } = await mandataire({
      declarees: [{ hote: "api.exemple.test", port: amont.port }],
      resoudre: () => new Promise<string[]>((ok) => { demarree = true; liberer = ok; }),
      exceptions: ["127.0.0.1"],
    });
    let recu = "";
    // Le client reste ouvert (demi-fermeture permise) : seul le mandataire a clos son écriture.
    const s: Socket = connect({ port, host: "127.0.0.1", allowHalfOpen: true }, () => s.write(requeteConnect(amont.port)));
    s.on("data", (d) => { recu += d.toString(); });
    s.on("error", () => undefined);
    ouverts.push({ close: () => s.destroy() });
    while (!demarree) await attendre(5);
    const cote = reglages.find((x) => x.ms === 10_000 && !x.socket.connecting);
    expect(cote).toBeDefined();
    cote?.socket.emit("timeout");
    while (!recu.includes("\r\n\r\n")) await attendre(5);
    liberer(["127.0.0.1"]);
    await attendre(150);
    expect(recu).toMatch(/^HTTP\/1\.1 504/);
    expect(amont.connexions()).toBe(0);
  });

  it("[A-329] en-tête CONNECT incomplet : l'expiration des 10 s donne 504 au client", async () => {
    const amont = await amontSilencieux();
    const reglages = espionnerDelais();
    const { port } = await mandataire({ declarees: [{ hote: "api.exemple.test", port: amont.port }], resoudre: async () => ["127.0.0.1"], exceptions: ["127.0.0.1"] });
    let recu = "";
    const fini = new Promise<void>((ok) => {
      const s: Socket = connect(port, "127.0.0.1", () => s.write(`CONNECT api.exemple.test:${amont.port} HTTP/1.1\r\nHost: api`));
      s.on("data", (d) => { recu += d.toString(); });
      s.on("close", () => ok());
      s.on("error", () => undefined);
    });
    while (!reglages.some((x) => x.ms === 10_000 && !x.socket.connecting)) await attendre(5);
    await attendre(30);
    reglages.find((x) => x.ms === 10_000 && !x.socket.connecting)?.socket.emit("timeout");
    await fini;
    expect(recu).toMatch(/^HTTP\/1\.1 504/);
    expect(amont.connexions()).toBe(0);
  });

  it("[A-329] avant le tunnel : 10 s côté client et côté amont ; une fois ouvert : 60 s d'inactivité des deux côtés", async () => {
    const amont = await amontSilencieux();
    const reglages = espionnerDelais();
    const { port } = await mandataire({ declarees: [{ hote: "api.exemple.test", port: amont.port }], resoudre: async () => ["127.0.0.1"], exceptions: ["127.0.0.1"] });
    const r = await new Promise<string>((ok) => {
      const s: Socket = connect(port, "127.0.0.1", () => s.write(requeteConnect(amont.port)));
      s.on("data", (d) => { ok(d.toString()); s.destroy(); });
      s.on("error", () => undefined);
    });
    expect(r).toMatch(/^HTTP\/1\.1 200/);
    const avant = new Set(reglages.filter((x) => x.ms === 10_000).map((x) => x.socket));
    const apres = new Set(reglages.filter((x) => x.ms === 60_000).map((x) => x.socket));
    expect(avant.size).toBeGreaterThanOrEqual(2); // client ET amont
    expect(apres.size).toBeGreaterThanOrEqual(2);
    for (const sk of apres) expect(avant.has(sk)).toBe(true); // les mêmes deux sockets passent de 10 s à 60 s
  });

  it.each(["client", "amont"] as const)("[A-329] tunnel ouvert : l'expiration du seul côté %s coupe les DEUX sockets, sans journal de la cible", async (cote) => {
    const amont = await amontSilencieux();
    const reglages = espionnerDelais();
    const journal = vi.spyOn(console, "log");
    const erreurs = vi.spyOn(console, "error");
    const { port } = await mandataire({ declarees: [{ hote: "api.exemple.test", port: amont.port }], resoudre: async () => ["127.0.0.1"], exceptions: ["127.0.0.1"] });
    const debut = performance.now();
    const clientFerme = new Promise<void>((ok) => {
      const s: Socket = connect(port, "127.0.0.1", () => s.write(requeteConnect(amont.port)));
      s.on("data", (d) => {
        if (!d.toString().startsWith("HTTP/1.1 200")) return;
        const longs = reglages.filter((x) => x.ms === 60_000).map((x) => x.socket);
        const cible = cote === "client" ? longs.find((x) => !x.remotePort || x.remotePort !== amont.port) : longs.find((x) => x.remotePort === amont.port);
        cible?.emit("timeout");
      });
      s.on("close", () => ok());
      s.on("error", () => undefined);
    });
    await clientFerme;
    await attendre(100);
    expect(amont.fermetures()).toBe(1); // l'amont a bien vu sa connexion coupée
    expect(performance.now() - debut).toBeLessThan(1_000); // coupure par l'expiration simulée, pas par une vraie attente
    for (const o of [journal, erreurs]) expect(JSON.stringify(o.mock.calls)).not.toContain("api.exemple.test");
  });

  it("[A-329] une connexion amont qui n'aboutit pas dans les 10 s reçoit 504 (et non 502)", async () => {
    const amont = await amontSilencieux();
    // Seul le socket sortant est encore « en connexion » au moment du réglage : on le fait expirer aussitôt.
    espionnerDelais((sk, ms) => {
      if (ms === 10_000 && sk.connecting) queueMicrotask(() => sk.emit("timeout"));
    });
    const { port } = await mandataire({ declarees: [{ hote: "api.exemple.test", port: amont.port }], resoudre: async () => ["127.0.0.1"], exceptions: ["127.0.0.1"] });
    const r = await brut(port, requeteConnect(amont.port));
    expect(r.ligne).toMatch(/^HTTP\/1\.1 504/);
  });
});
