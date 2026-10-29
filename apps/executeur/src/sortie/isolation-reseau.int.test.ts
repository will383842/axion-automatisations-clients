import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Contre le compose assemblé du socle (job socle-integration) : « docker compose config » sur tous les fragments.
// Lecture ligne à ligne de la sortie : aucun lecteur YAML, la mise en forme de compose ne compte pas.
const racine = fileURLToPath(new URL("../../../../", import.meta.url));

interface Assemble {
  reseaux: Map<string, string[]>;
  services: Map<string, string[]>;
}
function lireAssemble(texte: string): Assemble {
  const r: Assemble = { reseaux: new Map(), services: new Map() };
  let section = "";
  let courant: string[] | undefined;
  let dansReseaux = false;
  for (const ligne of texte.split("\n")) {
    if (!ligne.trim() || ligne.trim().startsWith("#")) continue;
    const indent = ligne.length - ligne.trimStart().length;
    const t = ligne.trim();
    if (indent === 0) {
      section = t.replace(/:.*$/, "");
      courant = undefined;
    } else if (indent === 2 && (section === "services" || section === "networks")) {
      courant = [];
      (section === "services" ? r.services : r.reseaux).set(t.replace(/:.*$/, ""), courant);
      dansReseaux = false;
    } else if (courant && section === "services" && indent === 4) {
      dansReseaux = t.startsWith("networks:");
    } else if (courant && section === "services" && dansReseaux && indent === 6) {
      courant.push(t.replace(/^- /, "").replace(/:.*$/, ""));
    } else if (courant && section === "networks" && indent === 4) {
      courant.push(t);
    }
  }
  return r;
}

describe("isolement réseau de l'exécuteur (intégration)", () => {
  it("[A-330] @isolation aucune connexion possible à la base console depuis le réseau de l'exécuteur", () => {
    const { reseaux, services } = lireAssemble(execFileSync("bash", ["ops/socle/lancer.sh", "--assembler"], { cwd: racine, encoding: "utf8" }));
    expect(reseaux.get("executeur-interne")).toContain("internal: true");
    // Aucun service de la base ne partage le réseau de l'exécuteur, et l'exécuteur n'est sur aucun autre réseau que les siens.
    for (const [nom, rs] of services) {
      if (/postgres|pgbouncer/.test(nom)) expect(rs, nom).not.toContain("executeur-interne");
      if (rs.includes("executeur-interne")) expect(rs.filter((x) => x !== "executeur-interne" && x !== "sortie"), nom).toEqual([]);
    }
  });
});
