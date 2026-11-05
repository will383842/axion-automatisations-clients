import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineAutomation, validerEcrans, type ContexteEtape, type Manifeste } from "./index.ts";
import { manifesteExemple } from "../exemples/module-exemple.ts";

const requete = { nom: "lister-prospects", mode: "lecture", parametres: { statut: { type: "texte", max: 40 } }, forme: { type: "simple", table: "commun.prospects", sortie: { lignes: [{ colonne: "id" }, { colonne: "nom" }] }, filtres: [{ colonne: "statut", operateur: "egal", parametre: "statut" }], limite: { fixe: 50 } } };
const action = { nom: "changer-statut", mode: "ecriture", parametres: {}, forme: requete.forme, historique: true };
const permission = { nom: "voir-prospects", libelle: "Voir les prospects", parDefaut: ["administrateur", "utilisateur"] };
const donnees = (surcharge: Record<string, unknown> = {}) => ({ requetes: [requete], actions: [], ...surcharge });
const avec = (surcharge: Record<string, unknown>) => ({ ...manifesteExemple, ...surcharge }) as unknown as Manifeste;
const accepte = (surcharge: Record<string, unknown>) => expect(() => defineAutomation(avec(surcharge))).not.toThrow();
const refuse = (surcharge: Record<string, unknown>, motif?: RegExp) => expect(() => defineAutomation(avec(surcharge))).toThrow(motif);
const ecran = (composant: string, proprietes: Record<string, unknown>) => ({ composant, proprietes });

describe("C4 0.5.0 : données et écrans d'un module (T4-49, T4-50a)", () => {
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

  it("[C-624] une requête qui porte un champ sql est refusée", () => {
    refuse({ donnees: donnees({ actions: [], requetes: [{ ...requete, sql: "select id from commun.prospects" }] }) }, /C4 0\.5\.0 : sql retiré \(ADR 0109\), déclarer une forme/);
    for (const cle of ["colonnes", "liste", "pagination", "parEtablissement", "extra"]) refuse({ donnees: { requetes: [{ ...requete, [cle]: true }], actions: [] } }, /donnees/);
  });

  it("[C-624] une action déclarée est refusée tant que l'écriture est fermée", () => {
    refuse({ donnees: { requetes: [requete], actions: [action] } }, /écriture est fermée/);
    accepte({ donnees: { requetes: [requete], actions: [] } });
  });

  it("[C-624] une table hors commun est refusée", () => {
    const avecTable = (table: string) => ({ requetes: [{ ...requete, forme: { ...requete.forme, table } }], actions: [] });
    for (const table of ["a_prospection.prospects", "public.prospects", "prospects", "commun.Prospects", "commun.prospects; drop", `commun.${"a".repeat(64)}`]) refuse({ donnees: avecTable(table) }, /donnees/);
    accepte({ donnees: avecTable("commun.prospects") });
  });

  it("[C-624] une requête en mode écriture ou avec plus de 30 paramètres est refusée", () => {
    refuse({ donnees: donnees({ requetes: [{ ...requete, mode: "ecriture" }] }) }, /donnees/);
    const n = (k: number) => Object.fromEntries(Array.from({ length: k }, (_, i) => [`p${i}`, { type: "uuid" }]));
    refuse({ donnees: donnees({ requetes: [{ ...requete, parametres: n(31) }] }) }, /30 paramètres/);
    // 30 n'est pas refusé pour sa taille (il l'est ici pour des paramètres inutilisés).
    refuse({ donnees: donnees({ requetes: [{ ...requete, parametres: n(30) }] }) }, /non utilisé/);
  });

  it("[C-624] l'établissement et les noms réservés ne sont jamais déclarables", () => {
    const forme = (surcharge: Record<string, unknown>) => ({ ...requete.forme, ...surcharge });
    const avecForme = (f: unknown, parametres: unknown = requete.parametres) => ({ requetes: [{ ...requete, parametres, forme: f }], actions: [] });
    refuse({ donnees: avecForme(forme({ sortie: { lignes: [{ colonne: "etablissement_id" }] } })) }, /donnees/);
    refuse({ donnees: avecForme(forme({ sortie: { lignes: [{ colonne: "id", alias: "tenant_id" }] } })) }, /donnees/);
    const p = { etablissement_id: { type: "uuid" } };
    refuse({ donnees: avecForme(forme({ filtres: [{ colonne: "etablissement_id", operateur: "egal", parametre: "etablissement_id" }] }), p) }, /donnees/);
    for (const nom of ["constructor", "valueOf", "pg_sleep", "current_user"]) refuse({ donnees: avecForme(forme({ filtres: [{ colonne: "statut", operateur: "egal", parametre: nom }] }), { [nom]: { type: "uuid" } }) }, /donnees/);
  });

  it("[C-624] une clé __proto__ propre est refusée, jamais ignorée", () => {
    const brut = JSON.parse(JSON.stringify({ requetes: [requete], actions: [] }));
    brut.requetes[0].parametres = JSON.parse('{"__proto__":"x","statut":{"type":"texte","max":40}}');
    refuse({ donnees: brut }, /donnees/);
    refuse({ donnees: JSON.parse('{"__proto__":{},"requetes":[],"actions":[]}') }, /donnees/);
  });

  it("[C-624] une requête incohérente (paramètre non déclaré, défaut invalide, bornes inversées, sans limite) est refusée", () => {
    const f = requete.forme;
    const avecReq = (r: Record<string, unknown>) => ({ requetes: [{ ...requete, ...r }], actions: [] });
    refuse({ donnees: avecReq({ forme: { ...f, filtres: [{ colonne: "statut", operateur: "egal", parametre: "autre" }] } }) }, /non déclaré|non utilisé/);
    refuse({ donnees: avecReq({ forme: { ...f, filtres: [{ colonne: "statut", operateur: "est_nul", parametre: "statut" }] } }) }, /inutile/);
    refuse({ donnees: avecReq({ parametres: { statut: { type: "texte", max: 2, defaut: "trop long" } } }) }, /défaut invalide/);
    refuse({ donnees: avecReq({ parametres: { statut: { type: "entier", min: 5, max: 1 } } }) }, /donnees/);
    refuse({ donnees: avecReq({ forme: { ...f, limite: undefined } }) }, /limite obligatoire/);
    refuse({ donnees: avecReq({ forme: { ...f, sortie: { lignes: [{ colonne: "id" }, { colonne: "nom", alias: "id" }] } } }) }, /répétés/);
  });

  it("[C-624] un manifeste 0.3.0 reste valide", () => {
    accepte({});
    expect(defineAutomation(avec({})).donnees).toBeUndefined();
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
    // L'écriture est fermée : aucune action n'est déclarable, donc aucun écran ne peut en nommer une.
    refuse({ donnees: donnees(), ecrans: [ecran("Formulaire", { titre: "Statut", action: "changer-statut" })] }, /action/);
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

  it("[C-624] le contexte d'étape type un port donnees en lecture seule (lire) qui ne prend que des noms et des paramètres", async () => {
    const appels: string[] = [];
    const port: NonNullable<ContexteEtape["donnees"]> = {
      lire: async (nom, parametres) => (appels.push(`lire:${nom}:${JSON.stringify(parametres)}`), []),
    };
    expect(await port.lire("lister-prospects", { statut: "ouvert" })).toEqual([]);
    expect(appels).toEqual(['lire:lister-prospects:{"statut":"ouvert"}']);
    // @ts-expect-error C4 0.5.0 : le port n'a plus d'écriture (ADR 0109).
    void port.ecrire;
  });

  it("[B-171] aucun champ du manifeste n'accepte du JavaScript (fonction, texte évalué)", () => {
    refuse({ donnees: donnees({ requetes: [{ ...requete, sql: () => "select 1" }] }) }, /donnees/);
    refuse({ donnees: donnees({ requetes: [{ ...requete, parametres: () => ({}) }] }) }, /donnees/);
    refuse({ permissions: [{ ...permission, libelle: () => "x" }] }, /permissions/);
    expect(validerEcrans([ecran("Tableau", { titre: "x", source: "${alert(1)}" })]).ok).toBe(false);
  });

  it("[A-300] un manifeste 0.3.0 reste valide tel quel, sans aucun champ nouveau", () => {
    accepte({});
    const m = defineAutomation(avec({}));
    expect(m.donnees).toBeUndefined();
    expect(m.permissions).toBeUndefined();
    expect(z.object({}).safeParse(m).success).toBe(true);
  });
});
