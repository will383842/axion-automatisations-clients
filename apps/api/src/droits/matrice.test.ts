import { describe, expect, it } from "vitest";
import { ACTIONS, ARGENT, ROLES, autorise, autoriseVolume, peutAnnulerAjustement, changementMembreAutorise } from "./matrice.js";

const D = "dirigeant";
const S = "second_administrateur";

describe("matrice des droits de l'équipe", () => {
  it("[C-568] le second administrateur ne peut ni émettre ni annuler une facture, ni lire un secret, ni publier, ni lancer une fin de contrat", () => {
    for (const a of ["emettre_facture", "annuler_facture", "connexions_secrets", "publier_catalogue", "fin_de_contrat"]) expect(autorise(S, a), a).toBe(false);
    expect(autorise(S, "lire")).toBe(true);
  });

  it("[C-617] pendant une absence, le second administrateur ne peut toujours ni émettre ni annuler une facture", () => {
    for (const a of ARGENT) expect(autorise(S, a, { absenceOuverte: true }), a).toBe(false);
    expect(autorise(S, "envoyer_notification_violation")).toBe(false);
    expect(autorise(S, "envoyer_notification_violation", { absenceOuverte: true })).toBe(true);
    expect(autorise(S, "lever_arret_urgence", { absenceOuverte: true })).toBe(true);
    expect(autorise(S, "lever_arret_urgence")).toBe(false);
  });

  it("[B-120] publier une version : dirigeant seul", () => {
    expect(autorise(D, "publier_catalogue")).toBe(true);
    expect(autorise(S, "publier_catalogue", { absenceOuverte: true })).toBe(false);
  });

  it("[B-123] utilisateurs et rôles : dirigeant seul", () => {
    expect(autorise(D, "utilisateurs_roles")).toBe(true);
    expect(autorise(S, "utilisateurs_roles", { absenceOuverte: true })).toBe(false);
  });

  it("[B-109] le dirigeant ne lit pas le contenu d'une base client sans accord", () => {
    expect(autorise(D, "lire_base_client")).toBe(false);
    expect(autorise(D, "lire_base_client", { accordClient: true })).toBe(true);
    expect(autorise(S, "lire_base_client", { accordClient: true })).toBe(false);
  });

  it("[LOT3-droits] la liste est fermée : rôle, action ou valeur inconnus sont refusés", () => {
    expect(ROLES).toEqual([D, S]);
    for (const r of ["", "membre", "Dirigeant", "membre_equipe", undefined as unknown as string]) expect(autorise(r, "lire"), String(r)).toBe(false);
    for (const a of ["", "tout", "__proto__", "constructor", undefined as unknown as string]) expect(autorise(D, a), String(a)).toBe(false);
    expect(ACTIONS.every((a) => typeof a === "string")).toBe(true);
  });

  it("[C-663] le second administrateur dépasse P1 cumulé → refus ; relever P2 : dirigeant seul", () => {
    const base = { p1: 100, cumulMois: 60, ajout: 40, clients: 1 };
    expect(autoriseVolume(S, base)).toBe(true);
    expect(autoriseVolume(S, { ...base, ajout: 41 })).toBe(false);
    expect(autoriseVolume(S, { ...base, clients: 2 })).toBe(false);
    expect(autoriseVolume(S, { ...base, p1: null })).toBe(false);
    expect(autoriseVolume(D, { ...base, p1: null, ajout: 1000 })).toBe(true);
    expect(autorise(D, "relever_p2")).toBe(true);
    expect(autorise(S, "relever_p2")).toBe(false);
    expect(autorise(S, "ecrire_parametres_forfaits")).toBe(false);
    expect(autorise(S, "lire_parametres_forfaits")).toBe(true);
  });

  it("[C-663] aucun rôle « membre de l'équipe »", () => {
    expect(ROLES as readonly string[]).not.toContain("membre");
    expect(ROLES as readonly string[]).not.toContain("membre_equipe");
    expect(autorise("membre", "lire")).toBe(false);
  });

  it("[C-664] annuler un ajustement : l'auteur ou un dirigeant seulement", () => {
    expect(peutAnnulerAjustement(S, { auteur: "a", acteur: "a" })).toBe(true);
    expect(peutAnnulerAjustement(S, { auteur: "a", acteur: "b" })).toBe(false);
    expect(peutAnnulerAjustement(D, { auteur: "a", acteur: "b" })).toBe(true);
  });

  it("[B-123] un membre ne change ni son rôle ni sa portée, et le dernier dirigeant ne se retire pas", () => {
    const moi = { sujet: "a", role: S as string };
    expect(changementMembreAutorise({ acteur: moi, cible: moi, nouveau: { role: D }, dirigeantsActifs: 1 })).toBe(false);
    expect(changementMembreAutorise({ acteur: moi, cible: moi, nouveau: { portee: ["x"] }, dirigeantsActifs: 1 })).toBe(false);
    const will = { sujet: "w", role: D as string };
    expect(changementMembreAutorise({ acteur: will, cible: will, nouveau: "retrait", dirigeantsActifs: 1 })).toBe(false);
    expect(changementMembreAutorise({ acteur: will, cible: moi, nouveau: { role: D }, dirigeantsActifs: 1 })).toBe(true);
    expect(changementMembreAutorise({ acteur: moi, cible: { sujet: "c", role: S }, nouveau: { role: D }, dirigeantsActifs: 1 })).toBe(false);
  });
});
