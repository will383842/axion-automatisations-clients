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
const SORTIE = "  chain sortie {\n    type filter hook output priority 0; policy drop;\n    oif \"lo\" accept\n    ct state established,related accept\n  }\n";
const AVEC_SORTIE = (t: string) => t.replace(/\}\n$/, `${SORTIE}}\n`);
const BONNE = AVEC_SORTIE(TABLE("    ct state established,related accept\n    iif \"lo\" accept\n    tcp dport 443 accept"));

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

// Liste blanche stricte (audit tour 1, ÉLEVÉ) : seules les instructions exactement prévues passent ; tout le reste est refusé, ligne dite.
// Contournements joués, un test chacun : instruction de haut niveau (add/insert/include/flush autre) ; instruction hors table ; règle dans un set ;
// chaîne sans crochet (régulière) ; prerouting/nat ; forward ; ip6 ; accept sur deux lignes ; deux instructions sur une ligne ; accept en SORTIE ;
// table ou chaîne en double ; accolade fermée trop tôt ; élément d'ensemble écrit en dur.
describe("pare-feu de l'hôte : liste blanche stricte", () => {
  const refus = (texte: string, motif?: RegExp) => {
    const e = analyserPareFeu(texte);
    expect(e.length, texte).toBeGreaterThan(0);
    if (motif) expect(e.join("\n")).toMatch(motif);
  };
  const dans = (corps: string) => BONNE.replace("tcp dport 443 accept", `tcp dport 443 accept\n${corps}`);
  it("[A-066] le fichier versionné passe la liste blanche sans écart", () => expect(analyserPareFeu(nft)).toEqual([]));
  it("[A-066] « add rule » de haut niveau ajoutée après la table est refusée", () => {
    refus(BONNE + "add rule inet axion entree tcp dport 22 accept\n", /add rule/);
    refus(BONNE + "add rule ip6 axion entree ip6 saddr ::/0 tcp dport 22 accept\n");
  });
  it("[A-066] « insert rule » et « include » sont refusés", () => {
    refus(BONNE + "insert rule inet axion entree tcp dport 22 accept\n", /insert rule/);
    refus(`include "/etc/nftables.d/*.nft"\n${BONNE}`, /include/);
  });
  it("[A-066] une instruction posée hors de toute table, après la dernière accolade, est refusée", () => refus(BONNE + "tcp dport 22 accept\n"));
  it("[A-066] une accolade fermée trop tôt laisse une règle au niveau de la table : refusée", () => {
    refus(BONNE.replace("    tcp dport 443 accept\n  }\n", "    tcp dport 443 accept\n  }\n  tcp dport 22 accept\n"));
  });
  it("[A-066] une règle d'entrée dans un ensemble (set) est refusée", () => {
    refus(BONNE.replace("table inet axion {\n", "table inet axion {\n  set sorties_permises {\n    type ipv4_addr\n    tcp dport 22 accept\n  }\n"));
  });
  it("[A-066] un élément d'ensemble écrit en dur est refusé (aucune adresse dans le dépôt)", () => {
    refus(BONNE.replace("table inet axion {\n", "table inet axion {\n  set sorties_permises {\n    type ipv4_addr\n    elements = { adresse-ecrite-en-dur }\n  }\n"));
  });
  it("[A-066] une chaîne régulière (sans crochet) portant un accept est refusée", () => {
    refus(BONNE.replace("table inet axion {\n", "table inet axion {\n  chain utilitaire {\n    tcp dport 22 accept\n  }\n"), /utilitaire|chaîne/);
  });
  it("[A-066] une chaîne prerouting / nat est refusée", () => {
    refus(BONNE.replace("table inet axion {\n", "table inet axion {\n  chain pre {\n    type nat hook prerouting priority -100; policy accept;\n    tcp dport 22 dnat to 10.0.0.1\n  }\n"));
    refus(BONNE.replace("table inet axion {\n", "table inet axion {\n  chain pre {\n    type filter hook prerouting priority -300; policy accept;\n  }\n"));
  });
  it("[A-066] une chaîne forward ouverte ou portant un accept est refusée", () => {
    refus(BONNE.replace("table inet axion {\n", "table inet axion {\n  chain forward {\n    type filter hook forward priority 0; policy accept;\n  }\n"));
    refus(BONNE.replace("table inet axion {\n", "table inet axion {\n  chain forward {\n    type filter hook forward priority 0; policy drop;\n    tcp dport 22 accept\n  }\n"));
  });
  it("[A-066] une règle IPv6 d'entrée (ip6 saddr, ::/0) est refusée", () => {
    refus(dans("    ip6 saddr ::/0 tcp dport 22 accept"));
    refus(dans("    ip6 nexthdr tcp accept"));
  });
  it("[A-066] un accept écrit sur deux lignes (ou continué par une barre oblique inverse) est refusé", () => {
    refus(dans("    tcp dport 22\n    accept"));
    refus(dans("    tcp dport 22 \\\n    accept"));
  });
  it("[A-066] deux instructions sur une ligne (point-virgule) sont refusées", () => {
    refus(dans("    tcp dport 443 accept; tcp dport 22 accept"));
    refus(dans("    tcp dport 443 accept ; accept"));
  });
  it("[A-066] une chaîne écrite sur une seule ligne avec ses règles est refusée", () => {
    refus(BONNE + "table inet autre { chain x { type filter hook input priority 0; policy accept; tcp dport 22 accept } }\n");
  });
  it("[A-066] une seconde table, même nommée comme la première, ou d'une autre famille (ip, ip6, bridge, arp) est refusée", () => {
    for (const f of ["inet", "ip", "ip6", "bridge", "arp", "netdev"]) refus(BONNE + `table ${f} axion {\n}\n`);
  });
  it("[A-066] une chaîne d'entrée en double est refusée", () => {
    refus(BONNE.replace("  chain sortie {", "  chain entree {\n    type filter hook input priority 0; policy drop;\n    tcp dport 22 accept\n  }\n  chain sortie {"));
  });
  it("[A-066] d'autres règles d'entrée, même fermantes (reject, log, counter, jump, goto, return) sont refusées : liste blanche", () => {
    for (const r of ["reject", "log", "counter", "jump utilitaire", "goto utilitaire", "return", "tcp dport 22 drop", "ct state new accept"]) refus(dans(`    ${r}`));
  });
  it("[A-066] le nom de la table ou une priorité différente de celle prévue est refusé (échec fermé)", () => {
    refus(BONNE.replace("priority 0; policy drop;\n    ct", "priority -400; policy drop;\n    ct"));
  });
  it("[C-533] un accept en SORTIE non prévu est refusé : accept nu, adresse libre, port libre, IPv6", () => {
    const sortie = (r: string) => BONNE.replace("    ct state established,related accept\n  }\n}", `    ct state established,related accept\n    ${r}\n  }\n}`);
    for (const r of ["accept", "tcp dport 25 accept", "ip daddr 0.0.0.0/0 accept", "ip6 daddr ::/0 accept", "udp dport 53 accept", "ip daddr @sorties_permises accept", "ip daddr @sorties_permises tcp dport 25 accept", "meta l4proto tcp accept"]) refus(sortie(r), /sortie|non permise/);
  });
  it("[C-533] seul « ip daddr @sorties_permises tcp dport 443 accept » est permis en sortie", () => {
    expect(analyserPareFeu(nft)).toEqual([]);
    expect(nft).toMatch(/ip daddr @sorties_permises tcp dport 443 accept/);
  });
  it("[C-533] la politique de sortie manquante, ou une chaîne de sortie absente, est refusée", () => {
    refus(BONNE.replace("policy drop;\n    oif", "policy accept;\n    oif"));
    refus(BONNE.replace(SORTIE, ""), /sortie/);
  });
  it("[A-066] une chaîne d'entrée sans la règle TCP 443 est refusée (rien ne serait servi)", () => refus(BONNE.replace("    tcp dport 443 accept\n", ""), /443/));
  it("[A-066] fin de ligne Windows, tabulations et espaces en trop sont tolérés mais ne cachent rien", () => {
    expect(analyserPareFeu(nft.replace(/\n/g, "\r\n"))).toEqual([]);
    refus(dans("\ttcp  dport\t22   accept"));
  });
  it("[A-066] le message d'écart cite la ligne fautive", () => refus(dans("    tcp dport 2222 accept"), /tcp dport 2222 accept/));
});

describe("règles de l'hébergeur : liste blanche stricte", () => {
  const json = JSON.parse(lire("./regles.json")) as Record<string, unknown>;
  it("[A-066] une clé inconnue (ex. entrant_ipv6) ou une source autre que « tout » est refusée", () => {
    expect(analyserReglesJson({ ...json, entrant_ipv6: [{ protocole: "tcp", port: "22" }] }).length).toBeGreaterThan(0);
    expect(analyserReglesJson({ ...json, entrant: [{ protocole: "tcp", port: "443", source: "::/0" }] }).length).toBeGreaterThan(0);
    expect(analyserReglesJson({ ...json, entrant: [{ protocole: "tcp", port: "443", source: "tout", extra: 1 }] }).length).toBeGreaterThan(0);
  });
  it("[A-066] un fichier d'hébergeur qui n'est pas un objet est refusé sans planter", () => {
    for (const v of [null, 3, "x", []]) expect(analyserReglesJson(v).length).toBeGreaterThan(0);
  });
  it("[A-066] l'écriture « 443 » avec espace ou en nombre n'est pas acceptée à la place du texte prévu", () => {
    expect(analyserReglesJson({ ...json, entrant: [{ protocole: "tcp", port: " 443", source: "tout" }] }).length).toBeGreaterThan(0);
    expect(analyserReglesJson({ ...json, entrant: [{ protocole: "tcp", port: "0443", source: "tout" }] }).length).toBeGreaterThan(0);
  });
});

describe("ports publiés par Docker", () => {
  it("[A-066] une adresse qui commence par 127.0.0.1 sans l'être (127.0.0.10, 127.0.0.1.evil) est refusée", () => {
    expect(portsMalPublies('services:\n  a:\n    ports: ["127.0.0.10:80:80", "127.0.0.1.x:81:81", "localhost:82:82"]\n').length).toBe(3);
  });
  it("[A-066] network_mode: host contourne le pare-feu : refusé", () => {
    expect(portsMalPublies("services:\n  a:\n    network_mode: host\n").length).toBe(1);
  });
  it("[A-066] forme longue : host_ip local accepté, absent ou ouvert refusé", () => {
    expect(portsMalPublies("services:\n  a:\n    ports:\n      - target: 80\n        published: 80\n        host_ip: 127.0.0.1\n").length).toBe(0);
    expect(portsMalPublies("services:\n  a:\n    ports:\n      - target: 80\n        published: 80\n").length).toBe(1);
    expect(portsMalPublies("services:\n  a:\n    ports:\n      - target: 80\n        published: 80\n        host_ip: 0.0.0.0\n").length).toBe(1);
  });
});
