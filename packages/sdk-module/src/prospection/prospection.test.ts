import { describe, expect, it } from "vitest";
import {
  creerListeExclusion,
  enregistrerOpposition,
  messageDeProspection,
  planifierInformations,
  sourcesDeclarees,
  verifierEnvoi,
} from "./index.ts";

// Textes de test : en production, ils viennent du catalogue de messages (à relire par le juriste).
const textes = { ligneDesinscription: (url: string) => `Se désinscrire : ${url}`, informationsPremierContact: "INFOS-ART-14" };
const desinscription = { mailto: "mailto:stop@exemple.fr", url: "https://desinscription.exemple.fr/u/abc" };
const base = {
  expediteur: { raisonSociale: "Atelier Bertin", adresse: "12 rue des Lilas, 69000 Lyon" },
  destinataire: { adresse: "directeur@exemple.fr" },
  fonction: "directeur d'agence",
  motifLien: "votre fonction concerne la rénovation de logements",
  objet: "Bonjour",
  corps: "Texte.",
  desinscription,
  textes,
};

describe("prospection conforme", () => {
  it("[C-081] un message sans raison sociale est refusé", () => {
    expect(() => messageDeProspection({ ...base, expediteur: { raisonSociale: " ", adresse: "12 rue des Lilas" } })).toThrow(/raison sociale/);
    expect(() => messageDeProspection({ ...base, expediteur: { raisonSociale: "Atelier Bertin", adresse: "" } })).toThrow(/adresse/);
  });

  it("[C-081] le corps porte l'identité de l'expéditeur", () => {
    const m = messageDeProspection(base);
    expect(m.corps).toContain("Atelier Bertin");
    expect(m.corps).toContain("12 rue des Lilas, 69000 Lyon");
  });

  it("[C-082] le message porte List-Unsubscribe et List-Unsubscribe-Post One-Click", () => {
    const m = messageDeProspection(base);
    expect(m.entetes["List-Unsubscribe"]).toBe("<mailto:stop@exemple.fr>, <https://desinscription.exemple.fr/u/abc>");
    expect(m.entetes["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    expect(m.corps).toContain("Se désinscrire : https://desinscription.exemple.fr/u/abc");
  });

  it("[C-082] une adresse de désinscription non HTTPS ou avec saut de ligne est refusée", () => {
    expect(() => messageDeProspection({ ...base, desinscription: { ...desinscription, url: "http://d.exemple.fr/u" } })).toThrow(/HTTPS/);
    expect(() => messageDeProspection({ ...base, desinscription: { ...desinscription, mailto: "mailto:a@exemple.fr\r\nBcc: x@exemple.fr" } })).toThrow(/mailto/);
  });

  it("[C-080] un message sans fonction du destinataire est refusé", () => {
    expect(() => messageDeProspection({ ...base, fonction: "" })).toThrow(/fonction/);
    expect(() => messageDeProspection({ ...base, motifLien: " " })).toThrow(/lien/);
  });

  it("[C-082] une opposition met le contact à l'écart sans rien supprimer, et l'envoi est refusé", () => {
    const liste = creerListeExclusion();
    enregistrerOpposition(liste, " Directeur@Exemple.fr ", "2026-10-26");
    expect(liste.entrees()).toEqual([{ adresse: "directeur@exemple.fr", date: "2026-10-26" }]);
    expect(() => verifierEnvoi(liste, messageDeProspection(base))).toThrow(/exclu/);
    expect(() => verifierEnvoi(creerListeExclusion(), messageDeProspection(base))).not.toThrow();
    expect("supprimer" in liste).toBe(false);
  });

  it("[C-087] un module de prospection sans source déclarée est refusé", () => {
    expect(() => sourcesDeclarees([])).toThrow(/source/);
    const ok = sourcesDeclarees([{ nom: "Annuaire public", baseLegale: "interet_legitime", dateObtention: "2026-10-01" }]);
    expect(ok).toHaveLength(1);
    expect(() => sourcesDeclarees([{ nom: "x", baseLegale: "inconnue", dateObtention: "2026-10-01" }] as never)).toThrow();
    expect(() => sourcesDeclarees([{ nom: "x", baseLegale: "consentement", dateObtention: "demain" }])).toThrow();
  });

  it("[C-070] une source LinkedIn est refusée", () => {
    for (const domaine of ["linkedin.com", "www.linkedin.com", "fr.linkedin.com", "LinkedIn.COM", "linkedin.com.", "lnkd.in"]) {
      expect(() => sourcesDeclarees([{ nom: "Réseau", domaine, baseLegale: "interet_legitime", dateObtention: "2026-10-01" }]), domaine).toThrow(/LinkedIn/i);
    }
    expect(() => sourcesDeclarees([{ nom: "Export LinkedIn", baseLegale: "interet_legitime", dateObtention: "2026-10-01" }])).toThrow(/LinkedIn/i);
    expect(sourcesDeclarees([{ nom: "Annuaire", domaine: "annuaire.exemple.fr", baseLegale: "interet_legitime", dateObtention: "2026-10-01" }])).toHaveLength(1);
  });

  it("[C-086] sans information au premier message, l'envoi est planifié à J+30 au plus tard", () => {
    const p = planifierInformations({ dateObtention: "2026-10-01", informationsDansPremierMessage: false, maintenant: "2026-10-05" });
    expect(p).toEqual({ mode: "planifie", auPlusTard: "2026-10-31", enRetard: false });
    const tard = planifierInformations({ dateObtention: "2026-10-01", informationsDansPremierMessage: false, maintenant: "2026-11-02" });
    expect(tard).toMatchObject({ mode: "planifie", enRetard: true });
    expect(planifierInformations({ dateObtention: "2026-10-01", informationsDansPremierMessage: true, maintenant: "2026-10-05" })).toEqual({ mode: "avec_premier_message" });
  });

  it("[C-086] l'étape standard ajoute les informations au premier message", () => {
    const m = messageDeProspection({ ...base, premierContact: true });
    expect(m.corps).toContain("INFOS-ART-14");
    expect(messageDeProspection(base).corps).not.toContain("INFOS-ART-14");
  });
});
