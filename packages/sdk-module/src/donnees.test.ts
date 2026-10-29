import { describe, expect, it } from "vitest";
import { z } from "zod";
import { CLES_CONTEXTE, defineAutomation, validerEcrans, type Manifeste } from "./index.ts";
import { manifesteExemple } from "../exemples/module-exemple.ts";

const requete = { nom: "lister-prospects", parametres: { type: "object", properties: {}, additionalProperties: false }, sql: "select id, nom from a_prospection.prospects where statut = $1", mode: "lecture", colonnes: ["id", "nom"], liste: true, pagination: { curseur: "id" }, parEtablissement: true };
const action = { nom: "changer-statut", parametres: { type: "object", properties: { statut: { type: "string" } }, additionalProperties: false }, sql: "update a_prospection.prospects set statut = $1 where id = $2", mode: "ecriture", colonnes: ["id"], liste: false, parEtablissement: true, historique: true };
const permission = { nom: "voir-prospects", libelle: "Voir les prospects", parDefaut: ["administrateur", "utilisateur"] };
const donnees = (surcharge: Record<string, unknown> = {}) => ({ requetes: [requete], actions: [action], ...surcharge });
const avec = (surcharge: Record<string, unknown>) => ({ ...manifesteExemple, ...surcharge }) as unknown as Manifeste;
const accepte = (surcharge: Record<string, unknown>) => expect(() => defineAutomation(avec(surcharge))).not.toThrow();
const refuse = (surcharge: Record<string, unknown>, motif?: RegExp) => expect(() => defineAutomation(avec(surcharge))).toThrow(motif);
const ecran = (composant: string, proprietes: Record<string, unknown>) => ({ composant, proprietes });

describe("C4 0.4.0 : données et écrans d'un module (T4-49)", () => {
  it("[C-624] un manifeste avec une requête déclarée valide est accepté ; un nom hors motif (souligné, majuscule) est refusé", () => {
    accepte({ donnees: donnees(), permissions: [permission] });
    refuse({ donnees: donnees({ requetes: [{ ...requete, nom: "lister_prospects" }] }) }, /donnees/);
    refuse({ donnees: donnees({ requetes: [{ ...requete, nom: "Lister" }] }) }, /donnees/);
    refuse({ donnees: donnees({ actions: [{ ...action, nom: "changer_statut" }] }) }, /donnees/);
    refuse({ permissions: [{ ...permission, nom: "voir_prospects" }] }, /permissions/);
    refuse({ fonctions: [{ nom: "Envoyer", libelle: "Envoyer" }] }, /fonctions/);
  });

  it("[B-170] Bouton { action: \"changer-statut\" } est accepté par le schéma existant de Bouton.action", () => {
    expect(validerEcrans([ecran("Bouton", { libelle: "Changer", action: "changer-statut" })]).ok).toBe(true);
    expect(validerEcrans([ecran("Bouton", { libelle: "Changer", action: "Changer_Statut" })]).ok).toBe(false);
  });

  it("[C-624] une requête de liste sans pagination par curseur est refusée", () => {
    const { pagination: _, ...sansPagination } = requete;
    refuse({ donnees: donnees({ requetes: [sansPagination] }) }, /pagination/);
    accepte({ donnees: donnees({ requetes: [{ ...requete, liste: false, pagination: undefined }] }) });
  });

  it("[C-625] une action d'écriture sans historique est refusée", () => {
    const { historique: _, ...sans } = action;
    refuse({ donnees: donnees({ actions: [sans] }) }, /historique/);
    refuse({ donnees: donnees({ actions: [{ ...action, historique: false }] }) }, /historique/);
  });

  it("[C-626] une requête qui nomme une permission non déclarée est refusée", () => {
    refuse({ donnees: donnees({ requetes: [{ ...requete, permission: "voir-prospects" }] }) }, /permission/);
    refuse({ donnees: donnees({ requetes: [{ ...requete, permission: "voir-prospects" }] }), permissions: [{ ...permission, nom: "autre-droit" }] }, /permission/);
    accepte({ donnees: donnees({ requetes: [{ ...requete, permission: "voir-prospects" }] }), permissions: [permission] });
    refuse({ permissions: [permission, permission] }, /permission/);
    refuse({ permissions: [{ ...permission, parDefaut: ["proprietaire"] }] }, /permissions/);
  });

  it("[B-170] un composant qui nomme une source non déclarée est refusé ; un nom déclaré est accepté", () => {
    const tableau = (source: string) => [ecran("Tableau", { titre: "Prospects", source })];
    refuse({ ecrans: tableau("lister-prospects") }, /source/);
    refuse({ donnees: donnees(), ecrans: tableau("inconnue") }, /source/);
    accepte({ donnees: donnees(), ecrans: tableau("lister-prospects") });
    refuse({ donnees: donnees(), ecrans: [ecran("Formulaire", { titre: "Statut", action: "inconnue" })] }, /action/);
    accepte({ donnees: donnees(), ecrans: [ecran("Formulaire", { titre: "Statut", action: "changer-statut" })] });
  });

  it("[B-170] les huit composants du portail existent ; les alias 0.3.0 restent acceptés", () => {
    const huit = ["Indicateur", "Tableau", "Graphique", "FileDeValidation", "Formulaire", "Import", "Calendrier", "FilActivite"];
    for (const nom of huit) expect(validerEcrans([ecran(nom, { titre: "T", libelle: "L" })]).erreurs.map((e) => e.code), nom).not.toContain("ecran.composant_inconnu");
    for (const alias of ["TableauSimple", "Carte", "Bandeau", "Statistique", "Lien", "Bouton"]) {
      expect(validerEcrans([ecran(alias, {})]).erreurs.map((e) => e.code), alias).not.toContain("ecran.composant_inconnu");
    }
  });

  it("[C-634] ia.modes absent vaut via_axion seul ; une valeur hors liste ou vide est refusée", () => {
    const ia = manifesteExemple.ia;
    expect(defineAutomation(avec({})).ia.modes).toEqual(["via_axion"]);
    expect(defineAutomation(avec({ ia: { ...ia, modes: ["client_direct", "via_axion"] } })).ia.modes).toEqual(["client_direct", "via_axion"]);
    refuse({ ia: { ...ia, modes: ["libre"] } }, /modes/);
    refuse({ ia: { ...ia, modes: [] } }, /modes/);
  });

  it("[C-637] une borne ia.garde à zéro ou négative est refusée ; absente, elle reste absente", () => {
    const ia = manifesteExemple.ia;
    const garde = { appelsMaxParExecution: 50, appelsMaxParElement: 5, appelsMaxParMinute: 30 };
    accepte({ ia: { ...ia, garde } });
    expect(defineAutomation(avec({})).ia.garde).toBeUndefined();
    for (const cle of Object.keys(garde)) {
      for (const valeur of [0, -1, 1.5]) refuse({ ia: { ...ia, garde: { ...garde, [cle]: valeur } } }, /garde/);
    }
    refuse({ ia: { ...ia, garde: { ...garde, extra: 1 } } }, /garde/);
  });

  it("[C-659] ia.utilise est un booléen déclaré par le module, jamais déduit", () => {
    const ia = manifesteExemple.ia;
    accepte({ ia: { ...ia, utilise: false } });
    refuse({ ia: { ...ia, utilise: "oui" } }, /utilise/);
  });

  it("[C-628] le manifeste déclare les fonctions dont l'état voulu cite les droits d'usage", () => {
    accepte({ fonctions: [{ nom: "envoi-courriel", libelle: "Envoi de courriels" }] });
    refuse({ fonctions: [{ nom: "envoi-courriel", libelle: "A" }, { nom: "envoi-courriel", libelle: "B" }] }, /fonctions/);
  });

  it("[C-624] le contexte d'étape expose un port donnees et rien d'autre de neuf", () => {
    expect([...CLES_CONTEXTE].sort()).toEqual(["donnees", "effet", "ia", "noterMotif", "reglages", "signal"]);
  });

  it("[B-171] aucun champ du manifeste n'accepte du JavaScript (fonction, texte évalué)", () => {
    refuse({ donnees: donnees({ requetes: [{ ...requete, sql: () => "select 1" }] }) }, /donnees/);
    refuse({ donnees: donnees({ requetes: [{ ...requete, parametres: () => ({}) }] }) }, /donnees/);
    refuse({ permissions: [{ ...permission, libelle: () => "x" }] }, /permissions/);
    refuse({ donnees: donnees({ requetes: [{ ...requete, sql: "select 1; drop table a_prospection.prospects" }] }) }, /sql/);
    refuse({ donnees: donnees({ requetes: [{ ...requete, sql: "select * from commun.t where x = '1' -- ${x}" }] }) }, /sql/);
    expect(validerEcrans([ecran("Tableau", { titre: "x", source: "${alert(1)}" })]).ok).toBe(false);
  });

  it("[C-624] le SQL n'a que des paramètres $1…$n et une requête lecture ne contient aucune écriture", () => {
    refuse({ donnees: donnees({ requetes: [{ ...requete, sql: "update a_prospection.prospects set statut = 'x'" }] }) }, /sql/);
    refuse({ donnees: donnees({ requetes: [{ ...requete, sql: "select id from a_prospection.prospects where statut = 'ouvert'" }] }) }, /sql/);
    refuse({ donnees: donnees({ actions: [{ ...action, mode: "lecture", sql: "delete from a_prospection.prospects where id = $1" }] }) }, /sql/);
    refuse({ donnees: donnees({ requetes: [{ ...requete, mode: "ecriture" }] }) }, /donnees/);
  });

  it("[A-300] un manifeste 0.3.0 reste valide tel quel, sans aucun champ nouveau", () => {
    accepte({});
    const m = defineAutomation(avec({}));
    expect(m.donnees).toBeUndefined();
    expect(m.permissions).toBeUndefined();
    expect(z.object({}).safeParse(m).success).toBe(true);
  });
});
