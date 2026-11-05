import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { analyserPareFeu, analyserReglesJson, portsMalPublies } from "./analyser.ts";

// Zone réseau, risque haut. Liste des attaques et erreurs de configuration (chacune a son test) :
//  1. politique d'entrée « accept » (tout ouvert)            2. un autre port TCP ouvert (22, 5432…)
//  3. une plage de ports ouverte                             4. un port UDP ouvert
//  5. un « accept » sans condition de port                   6. un port caché dans un ensemble « { 22, 443 } »
//  7. une seconde chaîne d'entrée restée ouverte             8. une table IPv4 seule (IPv6 laissé ouvert)
//  9. un « accept » avec commentaire trompeur               10. la sortie qui n'est pas fermée par défaut
// 11. un port de service publié sans adresse locale (Docker passe alors à côté du pare-feu de l'hôte)
// 12. le fichier de règles de l'hébergeur qui ouvre autre chose que 443 en entrée
const ici = (c: string) => fileURLToPath(new URL(c, import.meta.url));
const lire = (c: string) => readFileSync(ici(c), "utf8");
const nft = lire("./pare-feu-hote.nft");
const TABLE = (corps: string, famille = "inet") => `table ${famille} axion {\n  chain entree {\n    type filter hook input priority 0; policy drop;\n${corps}\n  }\n}\n`;
const BONNE = TABLE("    ct state established,related accept\n    iif \"lo\" accept\n    tcp dport 443 accept");

describe("pare-feu de l'hôte (lecture de la configuration)", () => {
  it("[A-066] le fichier versionné ouvre le port 443 et aucun autre port entrant", () => {
    expect(analyserPareFeu(nft)).toEqual([]);
    expect(nft).toMatch(/tcp dport 443 accept/);
  });
  it("[A-066] la configuration saine d'essai est acceptée", () => expect(analyserPareFeu(BONNE)).toEqual([]));
  it("[A-066] politique d'entrée « accept » refusée", () => expect(analyserPareFeu(BONNE.replace("policy drop", "policy accept")).length).toBeGreaterThan(0));
  it("[A-066] un autre port TCP ouvert est refusé", () => {
    for (const p of [22, 80, 5432, 6432, 8200, 8000]) expect(analyserPareFeu(TABLE(`    tcp dport 443 accept\n    tcp dport ${p} accept`)).length, `port ${p}`).toBeGreaterThan(0);
  });
  it("[A-066] une plage de ports ouverte est refusée", () => expect(analyserPareFeu(TABLE("    tcp dport 443-9000 accept\n    tcp dport 1-1024 accept")).length).toBeGreaterThan(0));
  it("[A-066] un port UDP ouvert est refusé", () => expect(analyserPareFeu(TABLE("    udp dport 443 accept")).length).toBeGreaterThan(0));
  it("[A-066] un accept sans condition de port est refusé", () => {
    expect(analyserPareFeu(TABLE("    accept")).length).toBeGreaterThan(0);
    expect(analyserPareFeu(TABLE("    tcp flags syn accept")).length).toBeGreaterThan(0);
  });
  it("[A-066] un port caché dans un ensemble est refusé", () => expect(analyserPareFeu(TABLE("    tcp dport { 22, 443 } accept")).length).toBeGreaterThan(0));
  it("[A-066] une seconde chaîne d'entrée ouverte est refusée", () => expect(analyserPareFeu(BONNE + "table inet autre {\n  chain x {\n    type filter hook input priority -10; policy accept;\n  }\n}\n").length).toBeGreaterThan(0));
  it("[A-066] une table IPv4 seule (IPv6 ouvert) est refusée", () => expect(analyserPareFeu(TABLE("    tcp dport 443 accept", "ip")).length).toBeGreaterThan(0));
  it("[A-066] un commentaire ne cache pas un accept", () => expect(analyserPareFeu(TABLE("    tcp dport 22 accept # tcp dport 443 accept")).length).toBeGreaterThan(0));
  it("[A-066] un fichier sans chaîne d'entrée est refusé (rien de vérifié)", () => expect(analyserPareFeu("# vide\n").length).toBeGreaterThan(0));
  it("[C-533] la sortie est fermée par défaut dans le fichier versionné", () => {
    expect(nft).toMatch(/hook output[^\n]*policy drop/);
    expect(analyserPareFeu(nft.replace(/(hook output[^\n]*)policy drop/, "$1policy accept")).length).toBeGreaterThan(0);
  });
});

describe("réseau privé et règles de l'hébergeur", () => {
  const json = JSON.parse(lire("./regles.json")) as Record<string, unknown>;
  it("[A-066] le fichier de l'hébergeur n'ouvre que le port 443 en entrée", () => {
    expect(analyserReglesJson(json)).toEqual([]);
    const sale = structuredClone(json) as { entrant: object[] };
    sale.entrant.push({ protocole: "tcp", port: "22", source: "tout" });
    expect(analyserReglesJson(sale).length).toBeGreaterThan(0);
  });
  it("[A-066] le fichier de l'hébergeur refuse aussi une plage, l'UDP et un protocole libre", () => {
    for (const regle of [{ protocole: "tcp", port: "1-1024" }, { protocole: "udp", port: "443" }, { protocole: "icmp" }, { protocole: "tcp" }]) {
      expect(analyserReglesJson({ ...json, entrant: [{ protocole: "tcp", port: "443", source: "tout" }, regle] }).length).toBeGreaterThan(0);
    }
  });
  it("[A-066] les services du réseau privé ne figurent jamais dans les règles entrantes", () => {
    const prives = (json as { reseau_prive: { ports_prives: number[] } }).reseau_prive.ports_prives;
    expect(prives.length).toBeGreaterThan(0);
    expect(prives).not.toContain(443);
    const sale = { ...json, entrant: [{ protocole: "tcp", port: String(prives[0]), source: "tout" }] };
    expect(analyserReglesJson(sale).length).toBeGreaterThan(0);
  });
  it("[A-066] aucun fichier de règles ne contient d'adresse IP écrite", () => {
    for (const f of ["pare-feu-hote.nft", "regles.json"]) expect(lire(`./${f}`), f).not.toMatch(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
  });
  it("[A-066] un port publié sans adresse locale est refusé, avec adresse locale accepté", () => {
    const mal = "services:\n  a:\n    ports:\n      - \"5432:5432\"\n  b:\n    ports: [\"0.0.0.0:8200:8200\", \"127.0.0.1:1:1\"]\n";
    expect(portsMalPublies(mal).length).toBe(2);
    expect(portsMalPublies("services:\n  a:\n    ports:\n      - \"127.0.0.1:8443:8443\"\n")).toEqual([]);
  });
  it("[A-066] aucun compose du socle ni des essais ne publie un port hors de l'adresse locale", () => {
    const dossiers = ["../socle", ".."];
    let lus = 0;
    for (const d of dossiers) {
      for (const f of readdirSync(ici(d)).filter((n) => /^compose.*\.ya?ml$/.test(n))) {
        lus++;
        expect(portsMalPublies(lire(`${d}/${f}`)), f).toEqual([]);
      }
    }
    expect(lus).toBeGreaterThan(3);
  });
});
