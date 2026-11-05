import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const DOSSIER = fileURLToPath(new URL("../../../ops/socle/openbao/politiques/", import.meta.url));
const lire = (nom: string) => readFileSync(`${DOSSIER}${nom}`, "utf8");
const sansCommentaires = (t: string) => t.replace(/#.*$/gm, "");
type Bloc = { chemin: string; capacites: string[] };
function blocs(texte: string): Bloc[] {
  return [...sansCommentaires(texte).matchAll(/path\s+"([^"]+)"\s*\{([^}]*)\}/g)].map((m) => ({ chemin: m[1]!, capacites: [...(m[2]!.match(/capabilities\s*=\s*\[([^\]]*)\]/)?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((c) => c[1]!) }));
}
// Un chemin de politique couvre un chemin cible : « + » vaut exactement un segment, « * » (en dernier caractère) vaut tout suffixe.
const echapper = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const couvre = (motif: string, cible: string) => {
  const final = motif.endsWith("*");
  const corps = (final ? motif.slice(0, -1) : motif).split("+").map(echapper).join("[^/]+");
  return new RegExp(`^${corps}${final ? ".*" : ""}$`).test(cible);
};
const lecteurs = (cible: string) => readdirSync(DOSSIER).filter((f) => f.endsWith(".hcl")).filter((f) => blocs(lire(f)).some((b) => couvre(b.chemin, cible) && b.capacites.some((c) => ["read", "sudo"].includes(c))));

describe("politiques OpenBao du courtier", () => {
  it("[A-055] aucun autre jeton du coffre que celui du courtier ne lit une valeur (politiques relues)", () => {
    expect(lecteurs("clients/data/11111111-1111-4111-8111-111111111111/x")).toEqual(["courtier.hcl"]);
    expect(blocs(lire("courtier.hcl"))).toEqual([{ chemin: "clients/data/*", capacites: ["read"] }]);
  });

  it("la politique courtier ne lit pas technique/data/echanges/ji (la vérification du jeton d'instance passe par l'API)", () => {
    expect(lecteurs("technique/data/echanges/ji/k1")).not.toContain("courtier.hcl");
    expect(lecteurs("technique/data/echanges/c4-cellule-1/k1")).not.toContain("courtier.hcl");
    expect(blocs(lire("courtier.hcl")).every((b) => b.chemin.startsWith("clients/data/"))).toBe(true);
  });

  it("[A-055] la lecture des politiques gère « + » (un segment) et « * » final", () => {
    expect(couvre("clients/+/*", "clients/data/t1/x")).toBe(true);
    expect(couvre("+/data/*", "clients/data/t1/x")).toBe(true);
    expect(couvre("clients/data/+/x", "clients/data/t1/x")).toBe(true);
    expect(couvre("clients/data/+/x", "clients/data/t1/y")).toBe(false);
    expect(couvre("clients/data/+/x", "clients/data/t1/z/x")).toBe(false);
    expect(couvre("clients/+/*", "technique/data/x")).toBe(false);
    expect(couvre("clients/data/*", "clients/data/t1/x")).toBe(true);
    expect(couvre("clients/data/*", "clients/other/t1/x")).toBe(false);
    expect(couvre("clients/data/t1", "clients/data/t1")).toBe(true);
  });
});
