import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// T5-12a : fragment compose d'Uptime Kuma et liste des moniteurs. Lecture de fichiers seulement (aucun Docker).
const lire = (chemin: string) => readFileSync(fileURLToPath(new URL(`../../../../../${chemin}`, import.meta.url)), "utf8");
const FRAGMENT = "ops/socle/compose.uptime-kuma.yml";

interface Moniteur {
  service: string;
  nom: string;
  type: string;
  hote: string;
  port: number;
  presence: string;
  composant?: string;
}
interface Liste {
  version: number;
  moniteurs: Moniteur[];
  exclus: Array<{ service: string; raison: string }>;
}
const liste = (): Liste => JSON.parse(lire("ops/socle/uptime-kuma/moniteurs.json")) as Liste;

// Noms de services d'un fragment : lignes « deux espaces + nom + deux-points » sous « services: ».
function services(texte: string): string[] {
  const noms: string[] = [];
  let dedans = false;
  for (const l of texte.split("\n")) {
    if (/^\S/.test(l)) dedans = l.startsWith("services:");
    else if (dedans) {
      const m = /^ {2}([a-z][a-z0-9-]*):\s*$/.exec(l);
      if (m?.[1]) noms.push(m[1]);
    }
  }
  return noms;
}
const fragmentsSocle = () =>
  readdirSync(fileURLToPath(new URL("../../../../../ops/socle", import.meta.url)))
    .filter((f) => /^compose\..+\.yml$/.test(f) && !f.startsWith("compose.zz-essai-") && f !== "compose.uptime-kuma.yml")
    .sort();

describe("Uptime Kuma : fragment compose", () => {
  it("[A-065] le fragment ne contient que le service uptime-kuma, sur le réseau interne, sans port publié", () => {
    const t = lire(FRAGMENT);
    expect(services(t)).toEqual(["uptime-kuma"]);
    expect(t).toMatch(/networks: \[interne\]/);
    expect(t).not.toMatch(/^\s+ports:/m);
    expect(t).not.toMatch(/entree/);
  });

  it("[A-065] l'image est épinglée par empreinte, sans latest, et inscrite dans ops/briques sous licence MIT", () => {
    const t = lire(FRAGMENT);
    const m = /image: (louislam\/uptime-kuma):(\d+\.\d+\.\d+)@(sha256:[0-9a-f]{64})/.exec(t);
    expect(m).not.toBeNull();
    const brique = JSON.parse(lire("ops/briques/uptime-kuma.json")) as Record<string, unknown>;
    expect(brique).toMatchObject({ nom: "uptime-kuma", image: m?.[1], version: m?.[2], empreinte: m?.[3], licence: "MIT" });
    expect(t).not.toMatch(/:latest/);
  });

  it("[A-065] aucun mot de passe ni secret en clair dans le fragment : seulement des variables exigées", () => {
    const t = lire(FRAGMENT);
    for (const l of t.split("\n").filter((x) => /PASSWORD|MOT_DE_PASSE|SECRET|TOKEN|KEY/i.test(x))) {
      expect(l, l).toMatch(/\$\{[A-Z_]+:\?|^\s*#/);
    }
  });
});

describe("Uptime Kuma : moniteurs", () => {
  it("[A-114] chaque service des fragments du socle a un moniteur ou une exclusion motivée", () => {
    const l = liste();
    const connus = new Set([...l.moniteurs.map((m) => m.service), ...l.exclus.map((e) => e.service)]);
    for (const f of ["compose.base.yml", ...fragmentsSocle().filter((x) => x !== "compose.base.yml")]) {
      for (const s of services(lire(`ops/socle/${f}`))) expect(connus.has(s), `${f} : service ${s} sans moniteur`).toBe(true);
    }
    for (const e of l.exclus) expect(e.raison.length).toBeGreaterThan(10);
  });

  it("[A-114] un moniteur présent dans le compose cite un service qui existe, et la liste couvre les briques attendues", () => {
    const l = liste();
    const reels = new Set(["compose.base.yml", ...fragmentsSocle()].flatMap((f) => services(lire(`ops/socle/${f}`))));
    for (const m of l.moniteurs.filter((x) => x.presence === "compose")) expect(reels.has(m.service), m.service).toBe(true);
    for (const attendu of ["api", "console", "portail", "courtier", "passerelle-ia", "valkey", "pgbouncer", "openbao", "stockage"]) {
      expect(l.moniteurs.some((m) => m.service === attendu), attendu).toBe(true);
    }
    expect(new Set(l.moniteurs.map((m) => m.service)).size).toBe(l.moniteurs.length);
  });

  it("[A-114] la liste ne contient ni secret, ni adresse IP, ni nom de domaine réel, ni nom hors jeu d'essai", () => {
    const brut = lire("ops/socle/uptime-kuma/moniteurs.json");
    expect(brut).not.toMatch(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
    expect(brut).not.toMatch(/password|secret|token|apikey/i);
    for (const m of liste().moniteurs) {
      expect(m.hote === m.service || m.hote.endsWith(".test"), m.hote).toBe(true);
      expect(["tcp", "http"]).toContain(m.type);
      expect(["compose", "lot-8a"]).toContain(m.presence);
    }
  });
});
