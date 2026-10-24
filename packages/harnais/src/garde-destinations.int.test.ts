import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { lireYaml } from "../../../scripts/garde-compose.js";
import { verifierDestinations } from "./garde-destinations.js";

describe("garde des destinations dans le socle", () => {
  it("[C-533] @envoi dans le compose assemblé du socle, aucune variable d'envoi ne vise un service hors du socle", () => {
    const texte = execFileSync("bash", ["ops/socle/lancer.sh", "--assembler"], { encoding: "utf8" });
    const compose = lireYaml(texte) as { services?: Record<string, { environment?: Record<string, string> }> };
    const services = new Set(Object.keys(compose.services ?? {}));
    const fautives: string[] = [];
    for (const [service, def] of Object.entries(compose.services ?? {})) {
      for (const nom of verifierDestinations(def.environment ?? {}, services)) fautives.push(`${service}.${nom}`);
    }
    expect(fautives).toEqual([]);
  });
});
