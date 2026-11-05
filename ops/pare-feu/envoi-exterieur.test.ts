import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { lireYaml } from "../../scripts/garde-compose.ts";

// Test de nuit « envoi extérieur bloqué » (C-533). Attaques et erreurs : un service sur un réseau non interne (sortie libre) ;
// un service sans réseau déclaré (réseau par défaut, ouvert) ; un conteneur de recette qui joint l'extérieur ; un envoi de courriel qui sort au lieu d'aller au piège.
const ici = (c: string) => fileURLToPath(new URL(c, import.meta.url));
const SCRIPT = ici("./envoi-exterieur-bloque.sh");
const socle = ici("../socle");

describe("réseaux du compose du socle (lecture statique)", () => {
  // Un fragment peut redéfinir un service d'un autre (ex. donnees) : les réseaux se fusionnent par nom, comme le fait compose.
  const parNom = new Map<string, { fichiers: string[]; reseaux: string[] | null }>();
  for (const f of readdirSync(socle).filter((n) => /^compose\.(?!zz-).*\.yml$/.test(n))) {
    const doc = lireYaml(readFileSync(join(socle, f), "utf8")) as unknown as { services?: Record<string, { networks?: string[] | Record<string, unknown> }> };
    for (const [nom, s] of Object.entries(doc.services ?? {})) {
      const avant = parNom.get(nom) ?? { fichiers: [], reseaux: null };
      const nouveaux = s.networks === undefined ? null : Array.isArray(s.networks) ? s.networks : Object.keys(s.networks);
      parNom.set(nom, { fichiers: [...avant.fichiers, f], reseaux: nouveaux === null ? avant.reseaux : [...(avant.reseaux ?? []), ...nouveaux] });
    }
  }
  const services = [...parNom.entries()].map(([nom, v]) => ({ nom, fichier: v.fichiers.join("+"), reseaux: v.reseaux }));
  it("[C-533] aucun service du socle sans réseau déclaré (le réseau par défaut a une sortie)", () => {
    expect(services.length).toBeGreaterThan(5);
    expect(services.filter((s) => s.reseaux === null).map((s) => `${s.fichier}:${s.nom}`)).toEqual([]);
  });
  it("[C-533] seul l'entrée (traefik) est hors réseau interne ; nul autre service sur « entree » ou « sortie »", () => {
    const ouverts = services.filter((s) => s.reseaux?.some((r) => r === "entree" || r === "sortie")).map((s) => s.nom);
    expect(ouverts).toEqual(["traefik"]);
  });
});

describe("script de nuit « envoi extérieur bloqué » (faux docker)", () => {
  let dossier = "";
  // Faux docker : « network ls » rend 3 réseaux dont 2 internes ; « run … » réussit (envoi sorti) si le réseau est FAUX_SORTIE, et vers le piège selon FAUX_PIEGE.
  const FAUX = `#!/usr/bin/env bash
case "$1 $2" in
  "network ls") printf 'socle_interne|true\\nsocle_entree|false\\nsocle_executeur-interne|true\\n'; exit 0 ;;
esac
if [ "$1" = "run" ]; then
  reseau="$4"
  case "$*" in *greenmail*) exit \${FAUX_PIEGE:-0} ;; esac
  [ "\${FAUX_SORTIE:-}" = "$reseau" ] && exit 0 || exit 1
fi
exit 1
`;
  beforeEach(() => {
    dossier = mkdtempSync(join(tmpdir(), "envoi-"));
    mkdirSync(join(dossier, "bin"));
    writeFileSync(join(dossier, "bin", "docker"), FAUX);
    chmodSync(join(dossier, "bin", "docker"), 0o755);
  });
  const lancer = (env: Record<string, string> = {}) =>
    spawnSync("bash", [SCRIPT], { encoding: "utf8", env: { PATH: `${join(dossier, "bin")}:/usr/bin:/bin`, IMAGE_SONDE: "sonde-fictive", ...env } });
  it("[C-533] tout est bloqué et le piège répond : code 0", () => {
    const r = lancer();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/envoi extérieur bloqué/);
  });
  it("[C-533] un conteneur qui joint l'extérieur fait échouer la nuit (code 1) et son nom est dit", () => {
    const r = lancer({ FAUX_SORTIE: "socle_executeur-interne" });
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toMatch(/socle_executeur-interne/);
  });
  it("[C-533] un piège muet fait échouer la nuit : un test sans piège ne prouve rien", () => {
    expect(lancer({ FAUX_PIEGE: "1" }).status).toBe(1);
  });
  it("[C-533] sans docker, le script échoue visiblement (jamais un faux vert)", () => {
    const r = spawnSync("/bin/bash", [SCRIPT], { encoding: "utf8", env: { PATH: "/nonexistent", IMAGE_SONDE: "x" } });
    expect(r.status).toBe(2);
  });
});
