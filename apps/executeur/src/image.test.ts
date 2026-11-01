import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { verifierCompose } from "../../../scripts/garde-compose.ts";
import { argumentsConteneur } from "./enveloppe/lancer.ts";

const brique = { nom: "x", image: "ghcr.io/exemple/x", version: "1", empreinte: `sha256:${"b".repeat(64)}`, licence: "MIT" };

const lire = (p: string) => readFileSync(fileURLToPath(new URL(`../../../${p}`, import.meta.url)), "utf8");
const dockerfile = lire("ops/images/axion-moteur/Dockerfile");
const entree = lire("ops/images/axion-moteur/point-entree.sh");
const compose = lire("ops/socle/compose.executeur.yml");
describe("image axion-moteur", () => {
  it("[A-327] l'image démarre en non root et refuse une écriture hors de /tmp", () => {
    const from = dockerfile.split("\n").filter((l) => /^FROM\s/i.test(l));
    expect(from).toHaveLength(1);
    expect(from[0]).toMatch(/@sha256:[0-9a-f]{64}$/);
    expect(dockerfile).toMatch(/^USER\s+[1-9]\d*(:[1-9]\d*)?\s*$/m);
    expect(dockerfile).not.toMatch(/^USER\s+(root|0)\b/im);
    expect(dockerfile).not.toMatch(/\.env|API_KEY|SECRET|PASSWORD|TOKEN/i);
    expect(entree).toMatch(/id -u/);
    expect(entree).toMatch(/exit 1/);
    expect(argumentsConteneur(brique)).toEqual(expect.arrayContaining(["--read-only", "--cap-drop=ALL", "--tmpfs=/tmp:rw,noexec,nosuid,size=64m"]));
  });
  it("[A-327] le compose passe la garde et n'ouvre aucune écriture hors du module enveloppe", () => {
    expect(verifierCompose("compose.executeur.yml", compose)).toEqual([]);
    expect(compose).not.toMatch(/docker\.sock|user:\s*"?(root|0)\b/);
  });
  it("[C-495] l'image ne contient aucun binaire headscale ni tailscale", () => {
    expect(dockerfile).not.toMatch(/headscale|tailscale/i);
    expect(entree).not.toMatch(/headscale|tailscale/i);
    expect(lire("ops/images/axion-moteur/README.md")).toMatch(/aucun.*(headscale|tailscale)/i);
  });
  it("[A-347] le compose de la cellule porte l'image par empreinte, jamais par étiquette", () => {
    // Tant que rien n'est publié, le compose n'a pas de service axion-moteur ; dès qu'il en aura un, son image portera l'empreinte.
    expect(compose).not.toMatch(/axion-moteur[^\n]*:(latest|\d[\w.-]*)\s*$/m);
    for (const l of compose.split("\n").filter((x) => /^\s*image:/.test(x))) expect(l).toMatch(/@sha256:[0-9a-f]{64}\s*$/);
  });
});
