import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { lireYaml } from "../../../../scripts/garde-compose.ts";

// Contre le compose assemblé du socle (job socle-integration) : « docker compose config » sur tous les fragments.
const racine = fileURLToPath(new URL("../../../../", import.meta.url));
type Doc = { services?: Record<string, { networks?: string[] | Record<string, unknown> }>; networks?: Record<string, { internal?: string }> };
const assemble = () => lireYaml(execFileSync("bash", ["ops/socle/lancer.sh", "--assembler"], { cwd: racine, encoding: "utf8" })) as Doc;
const reseauxDe = (s: { networks?: string[] | Record<string, unknown> } | undefined) => (Array.isArray(s?.networks) ? s.networks : Object.keys(s?.networks ?? {}));

describe("isolement réseau de l'exécuteur (intégration)", () => {
  it("[A-330] @isolation aucune connexion possible à la base console depuis le réseau de l'exécuteur", () => {
    const doc = assemble();
    expect(doc.networks?.["executeur-interne"]?.internal).toBe("true");
    const surInterne = Object.entries(doc.services ?? {}).filter(([, s]) => reseauxDe(s).includes("executeur-interne"));
    // Aucun service de la base ne partage le réseau de l'exécuteur, et aucun service de l'exécuteur n'est sur le réseau de la base.
    for (const [nom, s] of surInterne) {
      expect(nom).not.toMatch(/postgres|pgbouncer/);
      expect(reseauxDe(s).filter((r) => r !== "executeur-interne" && r !== "sortie")).toEqual([]);
    }
    for (const nom of ["postgres", "pgbouncer"]) expect(reseauxDe(doc.services?.[nom])).not.toContain("executeur-interne");
  });
});
