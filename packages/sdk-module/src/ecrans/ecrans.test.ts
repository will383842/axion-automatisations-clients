import { describe, expect, it } from "vitest";
import { COMPOSANTS, validerEcrans } from "../index.ts";

const ok = (e: unknown) => validerEcrans(e as never);
const refuse = (e: unknown) => {
  const r = ok(e);
  expect(r.ok).toBe(false);
  return r.ok ? [] : r.erreurs;
};
const carte = (proprietes: Record<string, unknown>) => [{ composant: "Carte", proprietes }];

describe("validerEcrans", () => {
  it("[B-170] un écran avec des composants standards est accepté", () => {
    expect(ok([{ composant: "TableauSimple", proprietes: { titre: "Accusés envoyés", colonnes: ["Date", "Objet"] } }, ...carte({ titre: "Bilan", ton: "vert" })])).toEqual({ ok: true, erreurs: [] });
  });

  it("[B-170] un écran avec un composant inconnu est refusé", () => {
    expect(refuse([{ composant: "ScriptLibre", proprietes: {} }])[0]).toMatchObject({ chemin: "0.composant", code: "ecran.composant_inconnu" });
  });

  it("[B-170] la liste des composants est fermée et gelée", () => {
    expect(Object.isFrozen(COMPOSANTS)).toBe(true);
    expect(Object.keys(COMPOSANTS)).toContain("TableauSimple");
  });

  it("[B-170] attaque : composant au nom piégé (__proto__, constructor, casse)", () => {
    for (const c of ["__proto__", "constructor", "toString", "carte", " Carte"]) refuse([{ composant: c, proprietes: {} }]);
  });

  it("[B-170] attaque : propriété inconnue ou de mauvais type refusée", () => {
    refuse(carte({ titre: "A", extra: 1 }));
    refuse(carte({ titre: 12 }));
    refuse(carte({ titre: "A", ton: "bleu" }));
  });

  it("[B-170] attaque : couleur en dur refusée, seuls les jetons de teinte passent", () => {
    for (const v of ["#fff", "#123456", "rgb(1,2,3)", "hsl(10 10% 10%)", "red"]) refuse(carte({ titre: "A", ton: v }));
    expect(ok(carte({ titre: "A", ton: "terracotta" })).ok).toBe(true);
  });

  it("[B-170] attaque : écrans qui ne sont pas une liste, ou trop profonds, refusés", () => {
    refuse({ composant: "Carte", proprietes: {} });
    refuse(null);
    let profond: unknown = "x";
    for (let i = 0; i < 40; i++) profond = { a: profond };
    refuse(carte({ titre: "A", donnees: profond }));
  });

  it("[B-170] attaque : une fonction ou un objet cyclique est refusé sans planter", () => {
    const cycle: Record<string, unknown> = {};
    cycle.soi = cycle;
    refuse(carte({ titre: "A", texte: () => 1 }));
    refuse(carte({ titre: "A", donnees: cycle }));
  });

  it("[B-171] un écran avec un gestionnaire onclick est refusé", () => {
    expect(refuse(carte({ titre: '<b onclick="x()">A</b>' }))[0]?.code).toBe("ecran.code_interdit");
    expect(refuse(carte({ titre: "A", onclick: "x()" }))[0]?.code).toBe("ecran.code_interdit");
  });

  it("[B-171] attaque : balise script, y compris en majuscules ou coupée", () => {
    for (const v of ["<script>alert(1)</script>", "<SCRIPT src=x>", "< script >", "<img src=x onerror=alert(1)>", "<svg/onload=alert(1)>", "<iframe src=x>"]) refuse(carte({ titre: v }));
  });

  it("[B-171] attaque : URL javascript: masquée", () => {
    const vs = ["javascript:alert(1)", "JaVaScRiPt:alert(1)", " java\nscript:alert(1)", "java\tscript:x", "ｊａｖａｓｃｒｉｐｔ:x", "&#106;avascript:x", "javascript&colon;x", "javascript%3Aalert(1)", "vbscript:x", "data:text/html;base64,AAAA", "​javascript:x"];
    for (const v of vs) refuse([{ composant: "Lien", proprietes: { libelle: "Voir", adresse: v } }]);
  });

  it("[B-171] une adresse de lien ne peut être qu'interne ou en https", () => {
    const lien = (adresse: string) => ok([{ composant: "Lien", proprietes: { libelle: "Voir", adresse } }]).ok;
    expect(lien("/automatisations/accuse")).toBe(true);
    expect(lien("https://exemple.test/aide")).toBe(true);
    expect(lien("//exemple.test")).toBe(false);
    expect(lien("http://exemple.test")).toBe(false);
  });

  it("[B-171] attaque : du code dans un texte (modèle, expression, fonction)", () => {
    for (const v of ["${process.env.X}", "{{constructor.constructor('x')()}}", "`x`", "eval('1')", "() => 1", "function(){}"]) refuse(carte({ titre: v }));
  });

  it("[B-171] attaque : clé __proto__ ou constructor dans les propriétés", () => {
    refuse(carte(JSON.parse('{"titre":"A","__proto__":{"x":1}}')));
    refuse(carte({ titre: "A", constructor: { x: 1 } }));
  });

  it("[B-171] un texte normal avec des mots proches n'est pas refusé à tort", () => {
    expect(ok(carte({ titre: "Données reçues : bonne journée, ouverture à 9 h", texte: "Contactez le service de la comptabilité." })).ok).toBe(true);
  });
});
