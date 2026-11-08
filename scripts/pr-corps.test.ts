import { describe, expect, it } from "vitest";
import { lireLigneExigences } from "./couverture-req.ts";
import { analyserArguments, genererCorps, ligneExigences } from "./pr-corps.ts";

describe("pr-corps : ligne Exigences", () => {
  it("accepte des identifiants A, B ou C séparés par des virgules", () => {
    expect(ligneExigences(["A-018", "B-225", "C-555"])).toBe("Exigences : A-018, B-225, C-555");
  });
  it("accepte « aucune (outillage) » quand il n'y a aucun identifiant", () => {
    expect(ligneExigences([])).toBe("Exigences : aucune (outillage)");
  });
  it("refuse un identifiant mal formé", () => {
    for (const mauvais of ["D-001", "A-01", "A-0001", "a-001", "A001", "C-12x", " A-001"]) {
      expect(() => ligneExigences([mauvais])).toThrow(/mal formé/);
    }
  });
  it("refuse un doublon", () => {
    expect(() => ligneExigences(["A-001", "A-001"])).toThrow(/deux fois/);
  });
});

describe("pr-corps : corps complet", () => {
  const corps = genererCorps({ exigences: [], fait: "Un script.", fichiers: ["scripts/a.ts"], tests: "rouge puis vert", reste: "rien" });
  it("commence par la ligne Exigences, relue par la garde de couverture", () => {
    expect(corps.split("\n")[0]).toBe("Exigences : aucune (outillage)");
    expect(lireLigneExigences(corps)).toBe("aucune (outillage)");
  });
  it("reprend les sections du modèle de PR, dans l'ordre", () => {
    const titres = [...corps.matchAll(/^## (.*)$/gm)].map((m) => m[1]);
    expect(titres).toEqual(["Ce qui est fait", "Exigences couvertes", "Fichiers touchés", "Tests rouges puis verts", "Ce qui reste", "Contrôles"]);
  });
  it("liste les fichiers et laisse les contrôles à cocher décochés", () => {
    expect(corps).toContain("- scripts/a.ts");
    expect(corps).toContain("- [ ] Aucun secret");
  });
  it("refuse un fichier vide ou une valeur vide", () => {
    expect(() => genererCorps({ exigences: [], fait: "", fichiers: [], tests: "x", reste: "x" })).toThrow(/fait/);
  });
});

describe("pr-corps : arguments", () => {
  it("lit --exigences, --fichier (répétable) et les textes", () => {
    const a = analyserArguments(["--exigences", "A-001,B-002", "--fait", "F", "--fichier", "x.ts", "--fichier", "y.ts", "--tests", "T", "--reste", "R"]);
    expect(a).toEqual({ exigences: ["A-001", "B-002"], fait: "F", fichiers: ["x.ts", "y.ts"], tests: "T", reste: "R" });
  });
  it("--aucune donne une liste vide ; sans l'un ni l'autre, erreur", () => {
    expect(analyserArguments(["--aucune", "--fait", "F", "--tests", "T", "--reste", "R"]).exigences).toEqual([]);
    expect(() => analyserArguments(["--fait", "F"])).toThrow(/--exigences ou --aucune/);
  });
  it("refuse une option inconnue", () => {
    expect(() => analyserArguments(["--zzz"])).toThrow(/inconnue/);
  });
});
