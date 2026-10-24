import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import config from "../vitest.config.js";
import { analyserArguments } from "./compter-tests.js";
import { verifierCompose } from "./garde-compose.js";

const lire = (chemin: string) => readFileSync(fileURLToPath(new URL(`../${chemin}`, import.meta.url)), "utf8");
const fixture = (nom: string) => lire(`scripts/__fixtures__/compose/${nom}`);
const EMPREINTE = "@sha256:1111111111111111111111111111111111111111111111111111111111111111";
const interne = (corps: string) => `services:\n${corps}\nnetworks:\n  interne:\n    internal: true\n`;

describe("garde-compose", () => {
  it("[A-086] garde-compose accepte un compose conforme", () => {
    expect(verifierCompose("ok.yml", fixture("ok.yml"))).toEqual([]);
  });
  it("[A-086] garde-compose refuse un port publié sur un service interne", () => {
    const erreurs = verifierCompose("port-interne.yml", fixture("port-interne.yml"));
    expect(erreurs.join("\n")).toMatch(/postgres.*ports/);
  });
  it("[A-084] garde-compose refuse un nom d'hôte pour un service interne", () => {
    const erreurs = verifierCompose("hote-interne.yml", fixture("hote-interne.yml"));
    expect(erreurs.join("\n")).toMatch(/litellm.*nom d'hôte/);
  });
  it("[A-086] garde-compose refuse une image sans empreinte", () => {
    const erreurs = verifierCompose("image-sans-empreinte.yml", fixture("image-sans-empreinte.yml"));
    expect(erreurs.join("\n")).toMatch(/valkey.*empreinte/);
  });
  it("[A-086] garde-compose refuse une image latest, même avec empreinte", () => {
    const t = interne(`  valkey:\n    image: valkey/valkey:latest${EMPREINTE}\n    networks: [interne]`);
    expect(verifierCompose("latest.yml", t).join("\n")).toMatch(/latest/);
  });
  it("[A-086] garde-compose refuse privileged, network_mode host et le socket Docker", () => {
    const base = `    image: exemple/x:1${EMPREINTE}\n    networks: [interne]\n`;
    expect(verifierCompose("a.yml", interne(`  x:\n${base}    privileged: true`)).join("\n")).toMatch(/privileged/);
    expect(verifierCompose("b.yml", interne(`  x:\n${base}    network_mode: host`)).join("\n")).toMatch(/network_mode/);
    const socket = `    volumes:\n      - /var/run/docker.sock:/var/run/docker.sock:ro`;
    expect(verifierCompose("c.yml", interne(`  x:\n${base}${socket}`)).join("\n")).toMatch(/socket/);
    const long = `    volumes:\n      - type: bind\n        source: /var/run/docker.sock\n        target: /s`;
    expect(verifierCompose("d.yml", interne(`  x:\n${base}${long}`)).join("\n")).toMatch(/socket/);
  });
  it("[A-086] garde-compose refuse un service interne sur le réseau entree", () => {
    const t = `services:\n  openbao:\n    image: exemple/x:1${EMPREINTE}\n    networks: [entree]\nnetworks:\n  entree: {}\n`;
    expect(verifierCompose("e.yml", t).join("\n")).toMatch(/openbao.*entree/);
  });
  it.each(["postgres", "pgbouncer", "valkey", "openbao", "litellm", "stockage", "keycloak-admin"])(
    "[A-086] garde-compose protège le service interne %s",
    (nom) => {
      const t = `services:\n  ${nom}:\n    image: exemple/x:1${EMPREINTE}\n    ports: ["1:1"]\n    networks:\n      - entree`;
      expect(verifierCompose("f.yml", t).length).toBeGreaterThanOrEqual(2);
    },
  );
  it("[A-084] garde-compose refuse un nom de domaine réel et tout domaine hors .test", () => {
    const base = `    image: exemple/x:1${EMPREINTE}\n    networks: [interne]\n`;
    const avec = (valeur: string) => interne(`  x:\n${base}    environment:\n      DOMAINE: ${valeur}`);
    expect(verifierCompose("g.yml", avec("console.axion-ia.com")).join("\n")).toMatch(/domaine/);
    expect(verifierCompose("h.yml", avec("exemple.fr")).join("\n")).toMatch(/domaine/);
    expect(verifierCompose("i.yml", avec("console.socle.test")).join("\n")).toBe("");
  });
  it("[A-084] garde-compose refuse, dans la configuration dynamique, une route vers un service interne", () => {
    const t = `http:\n  routers:\n    r:\n      rule: 'Host(\`ia.socle.test\`)'\n      service: s\n  services:\n    s:\n      loadBalancer:\n        servers:\n          - url: http://litellm:4000\n`;
    expect(verifierCompose("dyn.yml", t).join("\n")).toMatch(/litellm.*nom d'hôte/);
  });
  it("[A-066] dans le compose assemblé (docker compose config), seul le proxy publie un port", () => {
    expect(verifierCompose("assemble-ok.yml", fixture("assemble-ok.yml"))).toEqual([]);
    const erreurs = verifierCompose("assemble-port-interne.yml", fixture("assemble-port-interne.yml"));
    expect(erreurs.join("\n")).toMatch(/postgres.*ports/);
  });
  it("[A-066] le compose de base publie seulement 127.0.0.1:8443 et garde un réseau interne sans sortie", () => {
    const t = lire("ops/socle/compose.base.yml");
    expect(verifierCompose("compose.base.yml", t)).toEqual([]);
    expect(t.match(/^\s+ports:/gm)?.length).toBe(1);
    expect(t).toContain("127.0.0.1:8443:8443");
    expect(t).toMatch(/^\s+interne:\n\s+internal: true/m);
  });
  it("[A-084] la configuration de Traefik passe la garde, sans socket Docker", () => {
    expect(verifierCompose("dynamique.yml", lire("ops/socle/traefik/dynamique.yml"))).toEqual([]);
    expect(lire("ops/socle/traefik/statique.yml")).not.toContain("docker.sock");
  });
  it("[A-086] le fragment de test du routage passe la garde", () => {
    expect(verifierCompose("zz", lire("ops/socle/compose.zz-essai-routage.yml"))).toEqual([]);
  });
});

describe("options de compter-tests", () => {
  it("[C-538] --rapport et --reference sont lus, avec les valeurs par défaut d'avant", () => {
    expect(analyserArguments(["rapport-tests.json"])).toEqual({ rapport: "rapport-tests.json", reference: "spec/compte-tests.json" });
    expect(analyserArguments([])).toEqual({ rapport: "rapport-tests.json", reference: "spec/compte-tests.json" });
    expect(analyserArguments(["--rapport", "r.json", "--reference", "spec/compte-tests-integration.json"])).toEqual({
      rapport: "r.json",
      reference: "spec/compte-tests-integration.json",
    });
  });
  it("[C-538] une option sans valeur est refusée", () => {
    expect(() => analyserArguments(["--rapport"])).toThrow();
  });
});

describe("tests d'intégration et lancement", () => {
  it("[C-538] les projets par défaut excluent **/*.int.test.ts, le projet integration les prend", () => {
    const projets = (config.test?.projects ?? []) as { test: { name: string; exclude: string[]; include?: string[] } }[];
    for (const p of projets.filter((x) => x.test.name !== "integration")) expect(p.test.exclude).toContain("**/*.int.test.ts");
    expect(projets.some((p) => p.test.name === "integration")).toBe(true);
  });
  it("[A-066] les scripts de lancement existent et le fragment d'essai est réservé à la CI", () => {
    for (const f of ["lancer.sh", "arreter.sh", "README.md"]) expect(existsSync(fileURLToPath(new URL(`../ops/socle/${f}`, import.meta.url)))).toBe(true);
    expect(lire("ops/socle/lancer.sh")).toMatch(/GITHUB_ACTIONS/);
  });
  it("[A-066] le job socle-integration lit le dépôt seulement, sans environnement, et arrête le socle toujours", () => {
    const t = lire(".github/workflows/socle-integration.yml");
    expect(t).toMatch(/^permissions:\n\s+contents: read/m);
    expect(t).not.toMatch(/^\s*environment:/m);
    expect(t).toMatch(/if: always\(\)/);
    expect(t).toMatch(/compte-tests-integration\.json/);
  });
});
