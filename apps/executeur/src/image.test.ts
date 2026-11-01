import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { lireYaml, verifierCompose } from "../../../scripts/garde-compose.ts";

const lire = (p: string) => readFileSync(fileURLToPath(new URL(`../../../${p}`, import.meta.url)), "utf8");
const dockerfile = lire("ops/images/axion-moteur/Dockerfile");
const entree = lire("ops/images/axion-moteur/point-entree.sh");
const compose = lire("ops/socle/compose.executeur.yml");
type Service = { image?: string; user?: string; read_only?: string; tmpfs?: string[]; volumes?: string[]; cap_drop?: string[]; networks?: string[]; environment?: unknown };
const service = (lireYaml(compose) as { services?: Record<string, Service> }).services?.["axion-moteur"] ?? {};

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
    expect(service.read_only).toBe("true");
    expect(service.tmpfs?.join(" ")).toMatch(/^\/tmp:.*size=\d+[mM]/);
    expect(service.user).toMatch(/^[1-9]\d*(:[1-9]\d*)?$/);
    expect(service.cap_drop).toContain("ALL");
  });
  it("[A-327] aucun volume en écriture ne contourne la lecture seule, et le compose passe la garde", () => {
    expect(verifierCompose("compose.executeur.yml", compose)).toEqual([]);
    for (const v of service.volumes ?? []) expect(v).toMatch(/:ro$/);
    expect(JSON.stringify(service)).not.toMatch(/docker\.sock|"user":"(root|0)/);
  });
  it("[C-495] l'image ne contient aucun binaire headscale ni tailscale", () => {
    expect(dockerfile).not.toMatch(/headscale|tailscale/i);
    expect(entree).not.toMatch(/headscale|tailscale/i);
    expect(lire("ops/images/axion-moteur/README.md")).toMatch(/aucun.*(headscale|tailscale)/i);
  });
  it("[A-347] le compose de la cellule porte l'image par empreinte, jamais par étiquette", () => {
    expect(service.image).toMatch(/^[\w./-]+@sha256:[0-9a-f]{64}$/);
    expect(compose).not.toMatch(/:latest|image:\s*[^@\s]+:[\w.-]+\s*$/m);
  });
});
