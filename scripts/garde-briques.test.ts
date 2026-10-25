import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { lireImage, listerImages, verifierBriques, verifierVerrou } from "./garde-briques.js";

const lire = (chemin: string) => readFileSync(fileURLToPath(new URL(`../${chemin}`, import.meta.url)), "utf8");
const fixture = (nom: string) => lire(`scripts/__fixtures__/briques/${nom}`);
const EMP = `sha256:${"a".repeat(64)}`;
const brique = (surcharge: Record<string, unknown> = {}) => ({
  nom: "exemple",
  image: "exemple/exemple",
  version: "1.0.0",
  empreinte: EMP,
  licence: "MIT",
  livree: true,
  lieu: "local",
  source: "https://exemple.test/projet",
  verifie_le: "2026-10-24",
  ...surcharge,
});
const verifier = (surcharge: Record<string, unknown> = {}, compose = "") =>
  verifierBriques([{ fichier: `ops/briques/${String(surcharge.nom ?? "exemple")}.json`, contenu: brique(surcharge) }], compose ? [{ nom: "c.yml", texte: compose }] : []);
const composeDe = (image: string) => `services:\n  x:\n    image: ${image}\n`;

describe("garde-briques : licences et lieu de livraison", () => {
  it("[A-375] garde-briques refuse une brique livrée sous AGPL-3.0", () => {
    expect(verifier({ licence: "AGPL-3.0-only", livree: true }).join("\n")).toMatch(/exemple.*licence/);
  });
  it("[A-375] garde-briques refuse une brique livrée sous MPL-2.0, GPL, SSPL, BUSL et fair-code", () => {
    for (const licence of ["MPL-2.0", "GPL-3.0-or-later", "SSPL-1.0", "BUSL-1.1", "fair-code", "LicenseRef-Commerciale"]) {
      expect(verifier({ licence }), licence).not.toEqual([]);
    }
  });
  it("[A-375] garde-briques accepte les six licences du livre", () => {
    for (const licence of ["MIT", "BSD-2-Clause", "BSD-3-Clause", "ISC", "Apache-2.0", "PostgreSQL"]) expect(verifier({ licence }), licence).toEqual([]);
  });
  it("[A-375] garde-briques lit une expression : AGPL AND MIT refusée, MIT OR AGPL acceptée, texte illisible refusé", () => {
    expect(verifier({ licence: "MIT AND AGPL-3.0-only" })).not.toEqual([]);
    expect(verifier({ licence: "MIT OR AGPL-3.0-only" })).toEqual([]);
    expect(verifier({ licence: "(MIT OR" })).not.toEqual([]);
  });
  it("[A-379] garde-briques accepte OpenBao livree:false sous MPL-2.0", () => {
    expect(verifier({ nom: "openbao", image: "openbao/openbao", licence: "MPL-2.0", livree: false })).toEqual([]);
  });
  it("[A-379] garde-briques refuse OpenBao sous MPL-2.0 si livree:true", () => {
    expect(verifier({ nom: "openbao", image: "openbao/openbao", licence: "MPL-2.0", livree: true })).not.toEqual([]);
  });
  it("[A-379] garde-briques accepte une licence interdite livree:false seulement pour une brique de la liste fermée", () => {
    expect(verifier({ nom: "stockage-objet", image: "exemple/stockage", licence: "AGPL-3.0-only", livree: false })).toEqual([]);
    expect(verifier({ nom: "autre", image: "exemple/autre", licence: "AGPL-3.0-only", livree: false })).not.toEqual([]);
    expect(verifier({ nom: "stockage-objet", image: "exemple/stockage", licence: "AGPL-3.0-only", livree: true })).not.toEqual([]);
  });
  it("[A-379] garde-briques ne se laisse pas tromper par un nom de la liste fermée écrit autrement", () => {
    expect(verifier({ nom: "OpenBao", licence: "AGPL-3.0-only", livree: false })).not.toEqual([]);
    expect(verifier({ nom: "openbao-2", licence: "AGPL-3.0-only", livree: false })).not.toEqual([]);
  });
  it("[A-375] garde-briques refuse un nom qui ne correspond pas au nom du fichier", () => {
    const r = verifierBriques([{ fichier: "ops/briques/openbao.json", contenu: brique({ nom: "stockage-objet", licence: "AGPL-3.0-only", livree: false }) }], []);
    expect(r.join("\n")).toMatch(/nom/);
  });
  it("[A-375] garde-briques refuse livree donné autrement que par un booléen", () => {
    for (const livree of ["false", 0, null, undefined]) expect(verifier({ livree }), String(livree)).not.toEqual([]);
  });
  it("[A-375] garde-briques refuse une clé inconnue, un lieu inconnu, une date impossible et une source sans https", () => {
    expect(verifier({ extra: 1 })).not.toEqual([]);
    expect(verifier({ lieu: "ailleurs" })).not.toEqual([]);
    expect(verifier({ verifie_le: "2026-02-31" })).not.toEqual([]);
    expect(verifier({ source: "http://exemple.test" })).not.toEqual([]);
    expect(verifier({ source: "https://10.0.0.1/p" })).not.toEqual([]);
  });
  it("[A-375] garde-briques refuse un contenu qui n'est pas un objet", () => {
    for (const contenu of [null, [], "x", 3]) expect(verifierBriques([{ fichier: "ops/briques/x.json", contenu }], []), String(contenu)).not.toEqual([]);
  });
});

describe("garde-briques : redis, valkey, empreintes", () => {
  it("[A-378] garde-briques refuse une image redis", () => {
    expect(verifierBriques([], [{ nom: "compose-redis.yml", texte: fixture("compose-redis.yml") }]).join("\n")).toMatch(/redis/i);
  });
  it("[A-378] garde-briques refuse redis sous toutes ses écritures", () => {
    for (const image of ["redis:7", "REDIS:7", "bitnami/redis:7", "redis/redis-stack:7", "localhost:5000/library/redis@sha256:" + "b".repeat(64), "ghcr.io/acteur/redis-cluster:1"]) {
      expect(verifierBriques([], [{ nom: "c.yml", texte: composeDe(image) }]).join("\n"), image).toMatch(/redis/i);
    }
    expect(verifier({ nom: "files", image: "redis", version: "7.2" })).not.toEqual([]);
  });
  it("[C-493] garde-briques accepte valkey", () => {
    const valkey = brique({ nom: "valkey", image: "valkey/valkey", version: "8.0.1", empreinte: `sha256:${"c5d4f082b76d433a38274ebb38a43cff19829a062928bdcc45611135ef54e608"}`, licence: "BSD-3-Clause" });
    const r = verifierBriques([{ fichier: "ops/briques/valkey.json", contenu: valkey }], [{ nom: "compose-valkey.yml", texte: fixture("compose-valkey.yml") }]);
    expect(r).toEqual([]);
  });
  it("[A-381] garde-briques refuse une image sans empreinte", () => {
    for (const empreinte of [undefined, "", "sha256:abc", `sha256:${"A".repeat(64)}`, `md5:${"a".repeat(32)}`, `sha256:${"a".repeat(64)} `]) {
      expect(verifier({ empreinte }), String(empreinte)).not.toEqual([]);
    }
  });
  it("[A-381] garde-briques refuse une version latest ou vide", () => {
    expect(verifier({ version: "latest" })).not.toEqual([]);
    expect(verifier({ version: "" })).not.toEqual([]);
    expect(verifier({ image: "exemple/exemple:1.0.0" })).not.toEqual([]);
  });
  it("[A-381] garde-briques refuse une image du compose sans fichier de brique", () => {
    const r = verifierBriques([], [{ nom: "c.yml", texte: composeDe("exemple/inconnue:2.0.0") }]);
    expect(r.join("\n")).toMatch(/exemple\/inconnue.*aucune brique/);
  });
  it("[A-381] garde-briques refuse une empreinte du compose différente de celle de la brique", () => {
    const compose = composeDe(`exemple/exemple:1.0.0@sha256:${"b".repeat(64)}`);
    expect(verifier({}, compose).join("\n")).toMatch(/empreinte/);
    expect(verifier({}, composeDe(`exemple/exemple:1.0.0@${EMP}`))).toEqual([]);
    expect(verifier({}, composeDe("exemple/exemple:1.0.0"))).toEqual([]);
  });
  it("[A-381] garde-briques refuse une version du compose différente de celle de la brique", () => {
    expect(verifier({}, composeDe(`exemple/exemple:2.0.0@${EMP}`))).not.toEqual([]);
  });
  it("[A-381] garde-briques refuse une image du compose écrite avec une variable ou une ancre YAML mal formée", () => {
    expect(verifier({}, composeDe("${IMAGE_EXEMPLE}")).join("\n")).toMatch(/variable/);
    expect(verifier({}, "services: [").join("\n")).toMatch(/illisible/);
  });
  it("[A-381] garde-briques lit l'image à travers une ancre et une fusion YAML", () => {
    const compose = "x-base: &base\n  image: redis:7\nservices:\n  a:\n    <<: *base\n";
    expect(verifierBriques([], [{ nom: "c.yml", texte: compose }]).join("\n")).toMatch(/redis/i);
  });
  it("[A-381] garde-briques refuse deux fichiers pour la même image et la même version avec deux empreintes", () => {
    const a = { fichier: "ops/briques/a.json", contenu: brique({ nom: "a" }) };
    const b = { fichier: "ops/briques/b.json", contenu: brique({ nom: "b", empreinte: `sha256:${"b".repeat(64)}` }) };
    expect(verifierBriques([a, b], []).join("\n")).toMatch(/deux/);
  });
  it("[A-381] lireImage sépare le dépôt, la version et l'empreinte", () => {
    expect(lireImage("Docker.io/Library/Postgres:16.4@sha256:" + "d".repeat(64))).toEqual({ depot: "postgres", version: "16.4", empreinte: `sha256:${"d".repeat(64)}` });
    expect(lireImage("localhost:5000/axion/x")).toEqual({ depot: "localhost:5000/axion/x", version: "", empreinte: "" });
  });
});

describe("garde-briques : verrou pnpm", () => {
  it("[A-326] garde-briques refuse bullmq-pro dans le verrou", () => {
    expect(verifierVerrou(fixture("verrou-bullmq-pro.yaml")).join("\n")).toMatch(/bullmq-pro/);
  });
  it("[A-326] garde-briques accepte un verrou sans bullmq-pro", () => {
    expect(verifierVerrou(fixture("verrou-ok.yaml"))).toEqual([]);
  });
  it("[A-326] garde-briques refuse bullmq-pro écrit en majuscules, sous un alias ou dans une adresse d'archive", () => {
    expect(verifierVerrou("packages:\n  '@TaskForcesh/BullMQ-Pro@1.0.0': {}\n")).not.toEqual([]);
    expect(verifierVerrou("importers:\n  .:\n    dependencies:\n      queue:\n        specifier: npm:bullmq-pro@1\n        version: 1.0.0\n")).not.toEqual([]);
    expect(verifierVerrou("packages:\n  x@1.0.0:\n    resolution: {tarball: 'https://exemple.test/@taskforcesh/bullmq-pro/-/x.tgz'}\n")).not.toEqual([]);
  });
  it("[A-326] garde-briques refuse un verrou illisible ou vide (échec fermé)", () => {
    expect(verifierVerrou("packages: [")).not.toEqual([]);
    expect(verifierVerrou("")).not.toEqual([]);
  });
});

describe("garde-briques : miroir et dépôt", () => {
  it("[A-382] listerImages donne image@empreinte pour chaque brique, sans doublon", () => {
    const b = brique({ nom: "a" });
    expect(listerImages([b, b] as never)).toEqual([`exemple/exemple:1.0.0@${EMP}`]);
  });
  it("[A-382] ops/miroir-images.sh à blanc liste les images sans rien copier et n'accepte pas d'argument inconnu", () => {
    const sortie = execFileSync("bash", [fileURLToPath(new URL("../ops/miroir-images.sh", import.meta.url)), "--a-blanc"], { encoding: "utf8" });
    expect(sortie).toMatch(/^À BLANC .* -> ghcr\.io\//m);
    expect(() => execFileSync("bash", [fileURLToPath(new URL("../ops/miroir-images.sh", import.meta.url)), "--vrai"], { stdio: "pipe" })).toThrow();
  });
  it("[A-381] les fichiers ops/briques/*.json couvrent chaque image du dépôt (la garde complète tourne dans garde-briques.yml)", () => {
    const noms = readdirSync(fileURLToPath(new URL("../ops/briques", import.meta.url))).filter((f) => f.endsWith(".json") && f !== "schema.json");
    for (const attendu of ["traefik", "whoami", "mailpit", "postgres", "pgbouncer", "valkey", "openbao", "litellm"]) expect(noms).toContain(`${attendu}.json`);
  });
  it("[A-032] docs/localisation-des-donnees.md nomme chaque brique inscrite et signale le transfert hors UE à trancher par le juriste", () => {
    const doc = lire("docs/localisation-des-donnees.md");
    const dossier = fileURLToPath(new URL("../ops/briques", import.meta.url));
    for (const f of readdirSync(dossier).filter((x) => x.endsWith(".json") && x !== "schema.json")) {
      const nom = (JSON.parse(readFileSync(`${dossier}/${f}`, "utf8")) as { nom: string }).nom;
      expect(doc, nom).toContain(`\`${nom}\``);
    }
    expect(doc).toMatch(/hors UE/);
    expect(doc).toMatch(/juriste/);
  });
  it("[A-377] ops/procedure-nouvelle-dependance.md exige ScanCode, la relecture indépendante et une ligne dans la PR", () => {
    const p = lire("ops/procedure-nouvelle-dependance.md");
    expect(p).toMatch(/ScanCode/);
    expect(p).toMatch(/relecteur/);
    expect(p).toMatch(/ligne dans la PR/);
  });
});
