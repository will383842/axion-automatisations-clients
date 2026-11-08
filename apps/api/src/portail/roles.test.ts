import { describe, expect, it } from "vitest";
import { LECTURE_EN_POST, ROLES_CLIENT, autorise, type RoleClient } from "./roles.ts";

const P = "/api/portail/v1";
const ECRITURES = ["POST", "PUT", "PATCH", "DELETE"];
const RUBRIQUES_ECRITURE = ["automatisations", "equipe", "connexions", "export", "factures", "documents", "mon-entreprise/facturation", "mon-entreprise/contacts", "fin-de-contrat", "forfaits"];

describe("liste fermée rôle → routes", () => {
  it("[B-182] seul l'administrateur atteint utilisateurs, connexions, export et l'écriture de la facturation", () => {
    for (const r of ROLES_CLIENT) {
      const admin = r === "administrateur";
      for (const rub of ["equipe", "connexions", "export"]) expect(autorise(r, "GET", `${P}/${rub}`)).toBe(admin);
      expect(autorise(r, "PUT", `${P}/mon-entreprise/facturation`)).toBe(admin);
    }
  });

  it("[B-184] lecture seule : toute route d'écriture du portail reçoit 403", () => {
    for (const rub of RUBRIQUES_ECRITURE) for (const m of ECRITURES) expect(autorise("lecture_seule", m, `${P}/${rub}`)).toBe(false);
    expect(autorise("lecture_seule", "GET", `${P}/automatisations`)).toBe(true);
  });

  it("[B-185] comptable : factures et documents seulement", () => {
    expect(autorise("comptable", "GET", `${P}/factures`)).toBe(true);
    expect(autorise("comptable", "GET", `${P}/documents`)).toBe(true);
    for (const rub of ["automatisations", "equipe", "connexions", "export", "fin-de-contrat"]) expect(autorise("comptable", "GET", `${P}/${rub}`)).toBe(false);
  });

  it("[B-538] le comptable et la lecture seule changent leur mot de passe (rubrique mon-compte)", () => {
    for (const r of ROLES_CLIENT) expect(autorise(r, "POST", `${P}/mon-compte/mot-de-passe`)).toBe(true);
  });

  it("[B-539] le comptable lit mon-entreprise/facturation, pas mon-entreprise/contacts", () => {
    expect(autorise("comptable", "GET", `${P}/mon-entreprise/facturation`)).toBe(true);
    expect(autorise("comptable", "GET", `${P}/mon-entreprise/contacts`)).toBe(false);
  });

  it("[B-548] la route de demande de fin est refusée au comptable, à l'utilisateur et à la lecture seule", () => {
    for (const r of ["comptable", "utilisateur", "lecture_seule"] as RoleClient[]) expect(autorise(r, "POST", `${P}/fin-de-contrat`)).toBe(false);
    expect(autorise("administrateur", "POST", `${P}/fin-de-contrat`)).toBe(true);
  });

  it("[LOT6-roles] montee-en-ligne et equipe/droits-abonnement : refus pour les quatre rôles tant que la décision T6-35 manque", () => {
    for (const r of ROLES_CLIENT) for (const rub of ["montee-en-ligne", "equipe/droits-abonnement"]) expect(autorise(r, "GET", `${P}/${rub}`)).toBe(false);
  });

  it("[LOT6-roles] LECTURE_EN_POST ne contient que la route des données d'un module, ouverte à la lecture seule", () => {
    expect(LECTURE_EN_POST).toEqual([`POST ${P}/automatisations/:instance/donnees/:nom`]);
    expect(autorise("lecture_seule", "POST", `${P}/automatisations/:instance/donnees/:nom`)).toBe(true);
    expect(autorise("lecture_seule", "POST", `${P}/automatisations/:instance/autre`)).toBe(false);
  });
});
