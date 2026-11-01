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
const aService = /^ {2}axion-moteur:/m.test(compose);
describe("image axion-moteur", () => {
  it("le Dockerfile impose un amont épinglé, un utilisateur non root et un point d'entrée qui refuse le root (statique, l'image n'est pas construite ici)", () => {
    const from = dockerfile.split("\n").filter((l) => /^FROM\s/i.test(l));
    expect(from).toHaveLength(1);
    expect(from[0]).toMatch(/@sha256:[0-9a-f]{64}$/);
    expect(dockerfile).toMatch(/^USER\s+[1-9]\d*(:[1-9]\d*)?\s*$/m);
    expect(dockerfile).not.toMatch(/^USER\s+(root|0)\b/im);
    expect(dockerfile).not.toMatch(/\.env|API_KEY|SECRET|PASSWORD|TOKEN/i);
    expect(entree).toMatch(/id -u/);
    expect(entree).toMatch(/exit 1/);
  });
  it("le code de l'image appartient à root et n'est pas écrivable : seul /tmp est écrivable", () => {
    expect(dockerfile).not.toMatch(/--chown/);
    expect(dockerfile).toMatch(/chmod 0555/);
    expect(dockerfile).toMatch(/-type d[^\n]*chmod 0555/);
    expect(dockerfile).toMatch(/-type f[^\n]*chmod 0444/);
  });
  it("le conteneur enveloppe est lancé en lecture seule, sans capacité, avec un seul /tmp borné (ce n'est pas l'image moteur)", () => {
    expect(argumentsConteneur(brique)).toEqual(expect.arrayContaining(["--read-only", "--cap-drop=ALL", "--tmpfs=/tmp:rw,noexec,nosuid,size=64m"]));
  });
  it("le compose passe la garde et n'expose pas le socket Docker (garde : vide tant que le service axion-moteur n'existe pas)", () => {
    expect(verifierCompose("compose.executeur.yml", compose)).toEqual([]);
    expect(compose).not.toMatch(/docker\.sock|user:\s*"?(root|0)\b/);
  });
  it.todo("[A-327] le service axion-moteur du compose est non root et sans écriture hors /tmp (à prouver quand le service existe)");
  it("[C-495] l'image ne contient aucun binaire headscale ni tailscale", () => {
    expect(dockerfile).not.toMatch(/headscale|tailscale/i);
    expect(entree).not.toMatch(/headscale|tailscale/i);
    expect(lire("ops/images/axion-moteur/README.md")).toMatch(/aucun.*(headscale|tailscale)/i);
  });
  it("garde : dès que le service axion-moteur existe, son image porte l'empreinte", () => {
    for (const l of compose.split("\n").filter((x) => /^\s*image:/.test(x))) expect(l).toMatch(/@sha256:[0-9a-f]{64}\s*$/);
    if (aService) expect(compose).toMatch(/image:\s*\S+@sha256:[0-9a-f]{64}/);
  });
  it.todo("[A-347] le service axion-moteur du compose porte l'image par empreinte (à prouver quand le service existe)");
});
