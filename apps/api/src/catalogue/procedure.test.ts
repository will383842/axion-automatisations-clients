import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ErreurApi } from "../plugins/erreurs.js";
import { lireDemandePassage, lireDemandePreuve } from "./procedure.js";

// Données inventées : aucune adresse réelle, empreintes calculées, références fictives.
const EMPREINTE = createHash("sha256").update("version-essai").digest("hex");
const refuse = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    return e instanceof ErreurApi ? e.code : "autre";
  }
  return "accepte";
};
const cadrage = { probleme: "Relances de devis oubliées", declencheur: "Devis envoyé sans réponse", minutes_par_element: 6, donnees_personnelles: { presentes: true, categories: ["contact professionnel"] } };
const fiche = { benefice: "Moins de relances oubliées", prerequis: "Boîte de messagerie reliée", temps_gagne: "Dix minutes par devis", prix: "[montant]" };
const etape7 = { etape: 7, empreinte_sha256: EMPREINTE, mesure_ms: 1800, notes_de_version: "Première version", fiche };
const rapportVert = {
  module: "module-essai",
  version: "1.0.0",
  cas: [{ id: "cas-1", categorie: "nominal", reussi: true }],
  determinisme: [{ etape: "relecture", reussi: true }],
  hostile: { demandes: { refusees: 1, brouillons: 0, automatiques: 0 }, appelsConnecteur: 0, violations: 0 },
  totaux: { reussis: 2, echoues: 0 },
  codeSortie: 0,
};

describe("procédure : schémas stricts par étape", () => {
  it("[C-241] cadrage sans minutes par élément ou sans réponse sur les données personnelles : refusé", () => {
    expect(lireDemandePreuve({ etape: 1, empreinte_sha256: EMPREINTE, cadrage }).etape).toBe(1);
    const { minutes_par_element: _m, ...sansMinutes } = cadrage;
    const { donnees_personnelles: _d, ...sansDonnees } = cadrage;
    expect(refuse(() => lireDemandePreuve({ etape: 1, empreinte_sha256: EMPREINTE, cadrage: sansMinutes }))).toBe("schema_invalide");
    expect(refuse(() => lireDemandePreuve({ etape: 1, empreinte_sha256: EMPREINTE, cadrage: sansDonnees }))).toBe("schema_invalide");
    expect(refuse(() => lireDemandePreuve({ etape: 1, empreinte_sha256: EMPREINTE, cadrage: { ...cadrage, minutes_par_element: -1 } }))).toBe("schema_invalide");
    expect(refuse(() => lireDemandePreuve({ etape: 1, empreinte_sha256: EMPREINTE, cadrage: { ...cadrage, probleme: "" } }))).toBe("schema_invalide");
  });

  it("[C-247] fiche catalogue sans bénéfice, prérequis ou temps gagné : refusée ; un prix autre que « [montant] » : refusé", () => {
    expect(lireDemandePreuve(etape7).mesureMs).toBe(1800);
    for (const cle of ["benefice", "prerequis", "temps_gagne"]) {
      const { [cle]: _x, ...incomplete } = fiche as Record<string, string>;
      expect(refuse(() => lireDemandePreuve({ ...etape7, fiche: incomplete }))).toBe("schema_invalide");
    }
    for (const prix of ["49", 49, "49 € HT", "[Montant]", ""]) expect(refuse(() => lireDemandePreuve({ ...etape7, fiche: { ...fiche, prix } }))).toBe("schema_invalide");
  });

  it("[B-499] le temps de réponse mesuré est obligatoire à l'étape 7 et borné, et il n'existe que là", () => {
    const { mesure_ms: _m, ...sansMesure } = etape7;
    expect(refuse(() => lireDemandePreuve(sansMesure))).toBe("schema_invalide");
    expect(refuse(() => lireDemandePreuve({ ...etape7, mesure_ms: 0 }))).toBe("schema_invalide");
    expect(refuse(() => lireDemandePreuve({ ...etape7, mesure_ms: 3_600_001 }))).toBe("schema_invalide");
    expect(refuse(() => lireDemandePreuve({ etape: 2, empreinte_sha256: EMPREINTE, reference: "prototype-essai", mesure_ms: 5 }))).toBe("schema_invalide");
  });

  it("[C-240] aucune clé libre : toute clé inconnue, toute étape 9 ou 10 et tout contenu fourni à la main sont refusés", () => {
    expect(refuse(() => lireDemandePreuve({ etape: 2, empreinte_sha256: EMPREINTE, reference: "prototype-essai", contenu: { x: 1 } }))).toBe("schema_invalide");
    expect(refuse(() => lireDemandePreuve({ etape: 2, empreinte_sha256: EMPREINTE, reference: "prototype-essai", client: "x" }))).toBe("schema_invalide");
    expect(refuse(() => lireDemandePreuve({ etape: 1, empreinte_sha256: EMPREINTE, cadrage: { ...cadrage, commentaire_libre: "x" } }))).toBe("schema_invalide");
    for (const etape of [0, 9, 10, 11]) expect(refuse(() => lireDemandePreuve({ etape, empreinte_sha256: EMPREINTE, reference: "x-1" }))).toBe("schema_invalide");
    expect(refuse(() => lireDemandePreuve({ etape: 2, reference: "prototype-essai" }))).toBe("schema_invalide");
    expect(refuse(() => lireDemandePreuve({ etape: 2, empreinte_sha256: "ABC", reference: "prototype-essai" }))).toBe("schema_invalide");
  });

  it("[C-240] une preuve dont le contenu porte un téléphone espacé, ou dont la référence est un nombre de 9 ou 14 chiffres, est refusée", () => {
    expect(lireDemandePreuve({ etape: 2, empreinte_sha256: EMPREINTE, reference: "prototype-essai#12" }).reference).toBe("prototype-essai#12");
    for (const reference of ["123456789", "12345678901234", "a..b", "-debut", "x@exemple.fr", "a b"]) {
      expect(refuse(() => lireDemandePreuve({ etape: 2, empreinte_sha256: EMPREINTE, reference }))).toBe("schema_invalide");
    }
    for (const probleme of ["Appeler le 06 12 34 56 78", "Joindre 123 456 789", "Écrire à lucie@exemple.fr", "Numéro 06.12.34.56.78"]) {
      expect(refuse(() => lireDemandePreuve({ etape: 1, empreinte_sha256: EMPREINTE, cadrage: { ...cadrage, probleme } }))).toBe("schema_invalide");
    }
    expect(refuse(() => lireDemandePreuve({ ...etape7, notes_de_version: "Contact 01 02 03 04 05" }))).toBe("schema_invalide");
  });

  it("[C-202] l'étape 4 ne prend que le rapport du harnais : modeles_testes saisi à la main est refusé, la liste vient du rapport", () => {
    const d = lireDemandePreuve({ etape: 4, empreinte_sha256: EMPREINTE, rapport: { ...rapportVert, modeles: ["modele-essai-1", "modele-essai-2"] } });
    expect(d.modeles).toEqual(["modele-essai-1", "modele-essai-2"]);
    expect(d.rapport).toEqual({ module: "module-essai", version: "1.0.0", vert: true });
    expect(d.reference).toMatch(/^rapport:[0-9a-f]{64}$/);
    expect(lireDemandePreuve({ etape: 4, empreinte_sha256: EMPREINTE, rapport: rapportVert }).modeles).toBeNull();
    expect(refuse(() => lireDemandePreuve({ etape: 4, empreinte_sha256: EMPREINTE, rapport: rapportVert, modeles_testes: ["modele-essai-1"] }))).toBe("schema_invalide");
    expect(refuse(() => lireDemandePreuve({ etape: 4, empreinte_sha256: EMPREINTE, rapport: { ...rapportVert, modeles: ["Modèle Pirate"] } }))).toBe("schema_invalide");
    expect(refuse(() => lireDemandePreuve({ etape: 4, empreinte_sha256: EMPREINTE, rapport: { ...rapportVert, modeles: ["a..b"] } }))).toBe("schema_invalide");
    expect(refuse(() => lireDemandePreuve({ etape: 4, empreinte_sha256: EMPREINTE, rapport: { ...rapportVert, modeles: Array.from({ length: 17 }, (_, i) => `modele-${i}`) } }))).toBe("schema_invalide");
  });

  it("[C-244] un rapport du harnais qui n'est pas vert est lu comme non vert, même si ses totaux affirment le contraire", () => {
    const faux = { ...rapportVert, cas: [{ id: "cas-1", categorie: "nominal", reussi: false, ecart: "attendu autre" }] };
    expect(lireDemandePreuve({ etape: 4, empreinte_sha256: EMPREINTE, rapport: faux }).rapport?.vert).toBe(false);
    expect(lireDemandePreuve({ etape: 4, empreinte_sha256: EMPREINTE, rapport: { ...rapportVert, codeSortie: 1 } }).rapport?.vert).toBe(false);
    expect(lireDemandePreuve({ etape: 4, empreinte_sha256: EMPREINTE, rapport: { ...rapportVert, hostile: { ...rapportVert.hostile, violations: 1 } } }).rapport?.vert).toBe(false);
  });
});

describe("procédure : demande de passage stricte", () => {
  const base = { depart: "recette", vers: "pilote", empreinte_sha256: EMPREINTE };
  it("[A-305] la demande de passage dit l'état de départ et l'empreinte ; aucune clé libre", () => {
    expect(lireDemandePassage(base)).toMatchObject({ depart: "recette", vers: "pilote", empreinte: EMPREINTE, finAnnonceeLe: null, remplacanteId: null, prevenanceLe: null, signatureProduction: null });
    const { depart: _d, ...sansDepart } = base;
    const { empreinte_sha256: _e, ...sansEmpreinte } = base;
    expect(refuse(() => lireDemandePassage(sansDepart))).toBe("schema_invalide");
    expect(refuse(() => lireDemandePassage(sansEmpreinte))).toBe("schema_invalide");
    expect(refuse(() => lireDemandePassage({ ...base, statut: "publiee" }))).toBe("schema_invalide");
    expect(refuse(() => lireDemandePassage({ ...base, vers: "suspendue" }))).toBe("schema_invalide");
  });

  it("[B-461] une dépréciation porte une date de fin, et seule une dépréciation en porte une", () => {
    const depreciation = { depart: "publiee", vers: "depreciee", empreinte_sha256: EMPREINTE };
    expect(refuse(() => lireDemandePassage(depreciation))).toBe("schema_invalide");
    expect(refuse(() => lireDemandePassage({ ...depreciation, fin_annoncee_le: "2027-02-30" }))).toBe("schema_invalide");
    expect(refuse(() => lireDemandePassage({ ...depreciation, fin_annoncee_le: "2101-01-01" }))).toBe("schema_invalide");
    expect(lireDemandePassage({ ...depreciation, fin_annoncee_le: "2027-03-31" }).finAnnonceeLe).toBe("2027-03-31");
    expect(refuse(() => lireDemandePassage({ ...base, fin_annoncee_le: "2027-03-31" }))).toBe("schema_invalide");
  });

  it("[B-462] un retrait porte une remplaçante et une date de prévenance, et seul un retrait en porte", () => {
    const retrait = { depart: "depreciee", vers: "retiree", empreinte_sha256: EMPREINTE };
    const autre = "3b241101-e2bb-4255-8caf-4136c566a962";
    expect(refuse(() => lireDemandePassage(retrait))).toBe("schema_invalide");
    expect(refuse(() => lireDemandePassage({ ...retrait, remplacante_id: autre }))).toBe("schema_invalide");
    expect(refuse(() => lireDemandePassage({ ...retrait, prevenance_le: "2026-12-01" }))).toBe("schema_invalide");
    expect(refuse(() => lireDemandePassage({ ...retrait, remplacante_id: "pas-un-uuid", prevenance_le: "2026-12-01" }))).toBe("schema_invalide");
    expect(lireDemandePassage({ ...retrait, remplacante_id: autre, prevenance_le: "2026-12-01" })).toMatchObject({ remplacanteId: autre, prevenanceLe: "2026-12-01" });
    expect(refuse(() => lireDemandePassage({ ...base, remplacante_id: autre, prevenance_le: "2026-12-01" }))).toBe("schema_invalide");
  });

  it("[C-250] la signature de production n'est admise que pour une publication, avec une référence bornée", () => {
    const publication = { depart: "pilote", vers: "publiee", empreinte_sha256: EMPREINTE };
    expect(lireDemandePassage({ ...publication, signature_production: "signature-prod-essai" }).signatureProduction).toBe("signature-prod-essai");
    expect(refuse(() => lireDemandePassage({ ...publication, signature_production: "123456789" }))).toBe("schema_invalide");
    expect(refuse(() => lireDemandePassage({ ...base, signature_production: "signature-prod-essai" }))).toBe("schema_invalide");
  });
});
