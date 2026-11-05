import { createServer, type Server } from "node:net";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { constaterLuks } from "./constat-luks.ts";
import { constaterPorts, verdictPorts } from "./constat-ports.ts";
import { mesurerRemiseEnService } from "./remise-en-service.ts";

// Scripts de constat prêts pour le vrai serveur, essayés ici sur des sorties simulées.
// Erreurs visées : un volume de données sans couche chiffrée ; une sortie illisible prise pour « chiffré » ; un montage absent prise pour « chiffré » ;
// un port ouvert autre que 443 ; une mesure sans date de coupure ; un chronomètre qui court à l'envers ; une remise en service trop longue passée sous silence.
const lire = (c: string) => readFileSync(fileURLToPath(new URL(c, import.meta.url)), "utf8");
const disque = (enfants: object[]) => JSON.stringify({ blockdevices: [{ name: "sda", type: "disk", mountpoints: [null], children: enfants }] });
const CHIFFRE = disque([{ name: "sda1", type: "part", mountpoints: [null], children: [{ name: "donnees", type: "crypt", mountpoints: ["/var/lib/donnees"] }] }]);
const CLAIR = disque([{ name: "sda1", type: "part", mountpoints: ["/var/lib/donnees"] }]);

describe("constat des disques chiffrés", () => {
  it("[A-242] un volume de données monté sur une couche « crypt » est constaté chiffré", () => {
    expect(constaterLuks(CHIFFRE, ["/var/lib/donnees"])).toEqual([{ montage: "/var/lib/donnees", chiffre: true }]);
  });
  it("[A-242] un volume de données en clair est constaté non chiffré", () => {
    expect(constaterLuks(CLAIR, ["/var/lib/donnees"])).toEqual([{ montage: "/var/lib/donnees", chiffre: false }]);
  });
  it("[A-196] un montage absent de la sortie n'est jamais déclaré chiffré", () => {
    expect(constaterLuks(CHIFFRE, ["/var/lib/sauvegardes"])).toEqual([{ montage: "/var/lib/sauvegardes", chiffre: false }]);
  });
  it("[A-196] une sortie illisible ou une liste de montages vide est une erreur, pas un succès", () => {
    expect(() => constaterLuks("pas du json", ["/a"])).toThrow();
    expect(() => constaterLuks(CHIFFRE, [])).toThrow();
    expect(() => constaterLuks("{}", ["/a"])).toThrow();
  });
  it("[A-242] une couche « crypt » voisine, sur un autre disque, ne rend pas le volume en clair chiffré", () => {
    const deux = JSON.stringify({ blockdevices: [JSON.parse(CLAIR).blockdevices[0], JSON.parse(CHIFFRE).blockdevices[0]] });
    expect(constaterLuks(deux, ["/var/lib/donnees"]).every((x) => x.chiffre)).toBe(true); // le chiffré porte ce montage ici
    expect(constaterLuks(JSON.stringify({ blockdevices: [JSON.parse(CLAIR).blockdevices[0], { name: "sdb", type: "disk", mountpoints: [null], children: [{ name: "x", type: "crypt", mountpoints: ["/autre"] }] }] }), ["/var/lib/donnees"])[0]?.chiffre).toBe(false);
  });
});

describe("constat des ports depuis l'extérieur", () => {
  let serveurs: Server[] = [];
  afterEach(async () => { await Promise.all(serveurs.map((s) => new Promise((ok) => s.close(ok)))); serveurs = []; });
  const ecouter = () => new Promise<number>((ok) => { const s = createServer((c) => c.end()); serveurs.push(s); s.listen(0, "127.0.0.1", () => ok((s.address() as { port: number }).port)); });
  it("[A-066] un port qui répond est vu ouvert, un port fermé non", async () => {
    const p = await ecouter();
    expect(await constaterPorts("127.0.0.1", [p, 1], 500)).toEqual([p]);
  });
  it("[A-066] verdict : seul 443 ouvert = conforme ; tout autre port ouvert, ou aucun port 443, = écart", () => {
    expect(verdictPorts([443])).toEqual([]);
    expect(verdictPorts([22, 443]).length).toBe(1);
    expect(verdictPorts([]).length).toBe(1);
    expect(verdictPorts([8200, 5432, 443]).length).toBe(2);
  });
});

describe("mesure de la remise en service", () => {
  const T0 = 1_800_000_000;
  it("[C-044] 3 h 30 sont consignées et respectent les 4 h", () => {
    const m = mesurerRemiseEnService(T0, T0 + 3.5 * 3600);
    expect(m.dureeS).toBe(12600);
    expect(m.respecte).toBe(true);
    expect(m.ligne).toMatch(/3 h 30/);
  });
  it("[C-044] 5 h dépassent les 4 h : l'écart est écrit, rien n'est passé sous silence", () => {
    const m = mesurerRemiseEnService(T0, T0 + 5 * 3600);
    expect(m.respecte).toBe(false);
    expect(m.ligne).toMatch(/dépasse/);
    expect(m.ligne).toMatch(/1 h/);
  });
  it("[C-044] dates absentes, non numériques ou à l'envers : erreur, jamais une mesure", () => {
    expect(() => mesurerRemiseEnService(Number.NaN, T0)).toThrow();
    expect(() => mesurerRemiseEnService(T0, T0 - 1)).toThrow();
    expect(() => mesurerRemiseEnService(0, T0)).toThrow();
  });
});

describe("gestes de Will sur l'hébergeur (guide)", () => {
  const guide = lire("../../docs/serveur-de-test-gestes-de-will.md");
  it("[C-593] le guide demande un sous-compte en ajout seul, joignable du seul serveur de la console", () => {
    expect(guide).toMatch(/ajout seul/i);
    expect(guide).toMatch(/seul serveur de la console/);
  });
  it("[C-593] le guide ne contient ni jeton, ni clé, ni adresse, ni prix", () => {
    expect(guide).not.toMatch(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
    expect(guide).not.toMatch(/-----BEGIN|\b[A-Za-z0-9_-]{40,}\b|\d\s?€|\beuros?\b/);
  });
  it("[C-044] le guide dit de détruire la machine d'essai même en cas d'échec", () => {
    expect(guide).toMatch(/détruire/i);
    expect(guide).toMatch(/même en cas d'échec/);
  });
});
