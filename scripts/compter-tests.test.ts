import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { analyserArguments, analyserConfig, analyserSource, comparerParFichier, compterRapport, fichiersDeclares, lireListe, lireRetrait, verifierExecutes } from "./compter-tests.js";

const source = (nom: string) => readFileSync(fileURLToPath(new URL(`./__fixtures__/sources/${nom}`, import.meta.url)), "utf8");

describe("compter-tests", () => {
  it("compte les tests du rapport Vitest JSON", () => {
    expect(compterRapport({ numTotalTests: 42 })).toBe(42);
  });
  it("[C-538] compter-tests refuse un .skip sans fiche", () => {
    expect(analyserSource("a.test.ts", source("skip-sans-fiche.txt"))).not.toEqual([]);
  });
  it("[C-538] compter-tests accepte un .skip avec fiche ou l'étiquette [V2]", () => {
    expect(analyserSource("a.test.ts", source("skip-avec-fiche.txt"))).toEqual([]);
  });
  it("[C-538] compter-tests refuse retry sur un test @argent", () => {
    expect(analyserSource("a.test.ts", source("retry-argent.txt"))).not.toEqual([]);
  });
  it("[C-538] compter-tests laisse passer un test @argent sans retry et un retry ordinaire", () => {
    expect(analyserSource("a.test.ts", source("retry-ok.txt"))).toEqual([]);
  });
  it("[C-538] compter-tests refuse test.fails sans étiquette @lot-<n>", () => {
    expect(analyserSource("a.test.ts", source("fails-sans-lot.txt"))).not.toEqual([]);
    expect(analyserSource("a.test.ts", source("fails-avec-lot.txt"))).toEqual([]);
  });
  it.each(["skip-concurrent.txt", "skip-option.txt", "skip-if.txt"])("[C-538] compter-tests refuse la forme de saut %s", (f) => {
    expect(analyserSource("a.test.ts", source(f))).not.toEqual([]);
  });
  it("[C-538] compter-tests refuse un retry supérieur à 0 dans une configuration Vitest", () => {
    expect(analyserConfig("vitest.config.ts", source("config-retry.txt"))).not.toEqual([]);
    expect(analyserConfig("vitest.config.ts", source("config-retry-zero.txt"))).toEqual([]);
  });
  it("[C-538] compter-tests lit la liste de vitest list --json, par fichier, en chemins relatifs", () => {
    const liste = lireListe([{ name: "a", file: "/depot/scripts/x.test.ts" }, { name: "b", file: "/depot/scripts/x.test.ts" }, { name: "c", file: "/depot/apps/api/y.test.ts" }], "/depot");
    expect(liste).toEqual({ "scripts/x.test.ts": 2, "apps/api/y.test.ts": 1 });
    expect(() => lireListe({ erreur: true }, "/depot")).toThrow();
  });
  it("[C-538] compter-tests refuse une baisse dans un fichier", () => {
    expect(comparerParFichier({ "a.test.ts": 5 }, { "a.test.ts": 4 }, [])).not.toEqual([]);
    expect(comparerParFichier({ "a.test.ts": 5 }, { "a.test.ts": 5 }, [])).toEqual([]);
    expect(comparerParFichier({ "a.test.ts": 5 }, { "a.test.ts": 6, "b.test.ts": 1 }, [])).toEqual([]);
  });
  it("[C-538] compter-tests refuse un échange entre deux fichiers même si le total ne baisse pas", () => {
    expect(comparerParFichier({ "a.test.ts": 5, "b.test.ts": 1 }, { "a.test.ts": 2, "b.test.ts": 4 }, [])).not.toEqual([]);
  });
  it("[C-538] compter-tests refuse un fichier de test supprimé ou renommé sans déclaration", () => {
    expect(comparerParFichier({ "a.test.ts": 3 }, { "z.test.ts": 3 }, [])).not.toEqual([]);
  });
  it("[C-538] compter-tests accepte une baisse seulement si la déclaration est exacte", () => {
    const base = { "a.test.ts": 5 };
    const retrait = { fichier: "a.test.ts", avant: 5, apres: 3, raison: "deux cas fusionnés dans un tableau" };
    expect(comparerParFichier(base, { "a.test.ts": 3 }, [retrait])).toEqual([]);
    expect(comparerParFichier(base, { "a.test.ts": 2 }, [retrait])).not.toEqual([]);
    expect(comparerParFichier(base, { "a.test.ts": 3 }, [{ ...retrait, avant: 6 }])).not.toEqual([]);
    expect(comparerParFichier(base, {}, [{ ...retrait, apres: 0 }])).toEqual([]);
  });
  it("[C-538] compter-tests refuse une déclaration sans raison ou de forme inconnue", () => {
    const bon = JSON.stringify({ fichier: "a.test.ts", avant: 5, apres: 3, raison: "cas fusionnés" });
    expect(lireRetrait("spec/retraits/T1.json", bon).erreurs).toEqual([]);
    expect(lireRetrait("spec/retraits/T1.json", bon).retrait?.apres).toBe(3);
    for (const mauvais of [{ fichier: "a.test.ts", avant: 5, apres: 3, raison: " " }, { fichier: "a.test.ts", avant: 5, apres: 7, raison: "x" }, { fichier: "a.test.ts", avant: 5, apres: 3, raison: "x", autre: 1 }, { avant: 5 }]) {
      expect(lireRetrait("spec/retraits/T1.json", JSON.stringify(mauvais)).erreurs).not.toEqual([]);
    }
    expect(lireRetrait("spec/retraits/T1.json", "pas du json").erreurs).not.toEqual([]);
  });
  it("[C-538] compter-tests ne retient que les déclarations ajoutées par la PR, jamais une ancienne", () => {
    const sortie = "M\tspec/retraits/vieille.json\nA\tspec/retraits/neuve.json\nA\tautre/chose.json\nR100\tspec/retraits/a.json\tspec/retraits/b.json\n";
    expect(fichiersDeclares(sortie)).toEqual(["spec/retraits/neuve.json"]);
  });
  it("[C-538] compter-tests refuse un test listé mais non exécuté", () => {
    expect(verifierExecutes({ "a.test.ts": 3, "b.test.ts": 2 }, { numTotalTests: 4 })).not.toEqual([]);
    expect(verifierExecutes({ "a.test.ts": 3, "b.test.ts": 2 }, { numTotalTests: 6 })).not.toEqual([]);
    expect(verifierExecutes({ "a.test.ts": 3, "b.test.ts": 2 }, { numTotalTests: 5 })).toEqual([]);
  });
  it("[C-538] compter-tests lit --rapport, --projet et --base-ref, et refuse --reference", () => {
    expect(analyserArguments([])).toEqual({ rapport: "rapport-tests.json", projet: undefined, baseRef: "HEAD^1" });
    expect(analyserArguments(["rapport-tests.json"]).rapport).toBe("rapport-tests.json");
    expect(analyserArguments(["--rapport", "r.json", "--projet", "integration", "--base-ref", "origin/main"])).toEqual({ rapport: "r.json", projet: "integration", baseRef: "origin/main" });
    expect(() => analyserArguments(["--reference", "x.json"])).toThrow();
    expect(() => analyserArguments(["--rapport"])).toThrow();
  });
});
