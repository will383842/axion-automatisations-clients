import { readdirSync, readFileSync } from "node:fs";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { construireServeur } from "../serveur.js";
import { GARDE_VIDE, VIDE } from "./branchement.js";
import { BRANCHEMENTS, NOMS_BRANCHEMENTS, validerBranchements } from "./registre-branchements.js";

const DOSSIER = new URL("./branchements/", import.meta.url);
const fichiers = () => readdirSync(DOSSIER).sort();
const valide = { lister: () => undefined };

describe("registre des branchements de routes", () => {
  it("[C-536] le registre charge chaque fichier de routes/branchements dans l'ordre des noms, sans doublon de clé", () => {
    expect([...NOMS_BRANCHEMENTS]).toEqual(fichiers());
    expect(BRANCHEMENTS).toHaveLength(NOMS_BRANCHEMENTS.length);
    const cles = BRANCHEMENTS.flatMap((b) => (b.serveur && "cle" in b.serveur ? [String(b.serveur.cle)] : []));
    expect(new Set(cles).size).toBe(cles.length);
    expect(Object.isFrozen(BRANCHEMENTS)).toBe(true);
  });

  it("[C-536] le registre refuse un nom hors forme, un export sans lister, un serveur mal formé, une clé en double et un dossier vide", () => {
    const entree = (nom: string, module: unknown) => [{ nom, module }];
    expect(() => validerBranchements([])).toThrow(/vide/);
    expect(() => validerBranchements(entree("ClientsNotes.ts", { default: valide }))).toThrow(/nom/);
    expect(() => validerBranchements(entree("x.test.ts", { default: valide }))).toThrow(/nom/);
    expect(() => validerBranchements(entree("x.d.ts", { default: valide }))).toThrow(/nom/);
    expect(() => validerBranchements(entree("x.ts", { default: {} }))).toThrow(/lister/);
    expect(() => validerBranchements(entree("x.ts", {}))).toThrow(/lister/);
    expect(() => validerBranchements(entree("x.ts", { default: { ...valide, serveur: { toujours: false, brancher: () => undefined } } }))).toThrow(/serveur/);
    expect(() => validerBranchements(entree("x.ts", { default: { ...valide, serveur: { cle: "a" } } }))).toThrow(/serveur/);
    const a = { default: { ...valide, serveur: { cle: "fiche", brancher: () => undefined } } };
    expect(() => validerBranchements([{ nom: "a.ts", module: a }, { nom: "b.ts", module: a }])).toThrow(/fiche/);
    const ok = validerBranchements([{ nom: "b.ts", module: { default: valide } }, { nom: "a.ts", module: { default: valide } }]);
    expect(ok).toHaveLength(2);
    expect(Object.isFrozen(ok)).toBe(true);
  });

  it("[C-536] construireServeur ne branche une route que si sa clé est fournie (fermé par défaut)", () => {
    const sans = construireServeur({});
    expect(sans.hasRoute({ method: "GET", url: "/sante" })).toBe(true);
    expect(sans.hasRoute({ method: "GET", url: "/api/console/v1/clients/:id/fiche" })).toBe(false);
    const avec = construireServeur({ fiche: { ouvert: () => false, exigerEquipe: GARDE_VIDE, session: VIDE, lire: VIDE } });
    expect(avec.hasRoute({ method: "GET", url: "/api/console/v1/clients/:id/fiche" })).toBe(true);
  });

  it("[C-536] chaque clé du serveur appartient à un fichier dont lister enregistre au moins une route", () => {
    for (const [i, b] of BRANCHEMENTS.entries()) {
      const appli = Fastify();
      let n = 0;
      appli.addHook("onRoute", () => { n += 1; });
      b.lister(appli);
      expect(n, NOMS_BRANCHEMENTS[i]).toBeGreaterThan(0);
    }
  });

  it("[C-536] aucun fichier de branchement n'importe le chargeur du registre", () => {
    for (const nom of fichiers()) expect(readFileSync(new URL(nom, DOSSIER), "utf8"), nom).not.toMatch(/registre-branchements/);
  });
});
