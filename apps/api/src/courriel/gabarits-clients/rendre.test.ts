import { describe, expect, it } from "vitest";
import { CATALOGUE_EMAILS } from "../../../../../packages/contrats/src/messages/catalogue.js";
import { rendreClient } from "./rendre.js";

const ORIGINE = "https://portail.exemple.test";
const TEXTE = CATALOGUE_EMAILS["email.cestParti"];
const OK = { nomAutomatisation: "Relance des devis", lienEspace: `${ORIGINE}/espace`, adresseSupport: "service@exemple.fr" };

describe("rendu des e-mails des clients", () => {
  it("[C-557] le rendu remplace chaque variable déclarée, littéralement", () => {
    const m = rendreClient(TEXTE, { ...OK, nomAutomatisation: "$& $1 {lienEspace}" }, { originePortail: ORIGINE });
    expect(m.sujet).toContain("$& $1 {lienEspace}");
    expect(m.texte).toContain(`${ORIGINE}/espace`);
    expect(m.texte.startsWith("AXION IA")).toBe(true);
  });

  it("[C-557] une variable lien hors de l'origine du portail est refusée", () => {
    for (const lien of ["https://pirate.exemple.test/x", `${ORIGINE}.pirate.test/x`, "https://portail.exemple.test@pirate.test/x", "javascript:alert(1)"]) {
      expect(() => rendreClient(TEXTE, { ...OK, lienEspace: lien }, { originePortail: ORIGINE }), lien).toThrow();
    }
    expect(() => rendreClient(TEXTE, OK, {})).toThrow();
  });

  it("[C-557] variable à plusieurs lignes, en plus, manquante ou trop longue : refus", () => {
    const o = { originePortail: ORIGINE };
    expect(() => rendreClient(TEXTE, { ...OK, nomAutomatisation: "a\nBcc: x@exemple.fr" }, o)).toThrow();
    expect(() => rendreClient(TEXTE, { ...OK, nomAutomatisation: "a\r" }, o)).toThrow();
    expect(() => rendreClient(TEXTE, { ...OK, nomAutomatisation: "a\u0000" }, o)).toThrow();
    expect(() => rendreClient(TEXTE, { ...OK, nomAutomatisation: "" }, o)).toThrow();
    expect(() => rendreClient(TEXTE, { ...OK, nomAutomatisation: "x".repeat(201) }, o)).toThrow();
    expect(() => rendreClient(TEXTE, { ...OK, enPlus: "x" }, o)).toThrow();
    const { adresseSupport: _a, ...manquante } = OK;
    expect(() => rendreClient(TEXTE, manquante, o)).toThrow();
  });
});
