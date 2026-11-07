import { describe, expect, it } from "vitest";
import { TABLE_ENVOIS } from "./table.ts";

const DESTINATAIRES_PERMIS = ["administrateur_client", "collegue_invite", "will"];

describe("[C-557] table unique des envois", () => {
  it("[C-557] tout envoi V1 a canal \"email\"", () => {
    const v1 = TABLE_ENVOIS.filter((e) => e.version === "V1");
    expect(v1.length).toBeGreaterThan(0);
    for (const e of v1) expect(e.canal, e.evenement).toBe("email");
  });

  it("[C-557] aucun envoi de mode \"automatique\" n'a un destinataire hors du client concerné ou de Will", () => {
    for (const e of TABLE_ENVOIS.filter((x) => x.mode === "automatique")) {
      expect(DESTINATAIRES_PERMIS, e.evenement).toContain(e.destinataire);
    }
  });

  it("[C-557] chaque événement est unique et chaque envoi a un interrupteur", () => {
    const evenements = TABLE_ENVOIS.map((e) => e.evenement);
    expect(new Set(evenements).size).toBe(evenements.length);
    for (const e of TABLE_ENVOIS) expect(e.interrupteur, e.evenement).toMatch(/^envoi\.[a-zA-Z0-9]+$/);
  });

  it("[C-557] la relance d'impayé est \"clic_will\"", () => {
    const relance = TABLE_ENVOIS.find((e) => e.evenement === "relanceImpaye");
    expect(relance?.mode).toBe("clic_will");
  });

  it("[C-557] « C'est parti », « Lancement en cours » et la reconnexion sont automatiques", () => {
    for (const ev of ["cestParti", "lancementEnCours", "lienReconnexion"]) {
      expect(TABLE_ENVOIS.find((e) => e.evenement === ev)?.mode, ev).toBe("automatique");
    }
  });

  it("[C-557] aucun envoi commercial automatique : la relance de non-paiement et la violation partent d'un clic", () => {
    for (const ev of ["nonPaiement30Jours", "notificationViolation"]) {
      expect(TABLE_ENVOIS.find((e) => e.evenement === ev)?.mode, ev).toBe("clic_will");
    }
  });

  it("[C-614] alertes de palier à 80 % et à 100 %, pour le client et pour Will", () => {
    for (const ev of ["palier80Client", "palier100Client", "palier80Will", "palier100Will"]) {
      expect(TABLE_ENVOIS.find((e) => e.evenement === ev)?.mode, ev).toBe("automatique");
    }
  });

  it("[C-603] l'e-mail de reconnexion déclare deux conditions : connexion testée en échec ET aucun incident ouvert sur le connecteur", () => {
    const reconnexion = TABLE_ENVOIS.find((e) => e.evenement === "lienReconnexion");
    expect(reconnexion?.conditions).toEqual(["connexionTesteeEnEchec", "aucunIncidentOuvertSurConnecteur"]);
  });

  it("[C-557] la table garde ses 18 lignes, leurs modes, destinataires, interrupteurs et conditions", () => {
    const attendu = [
      ["invitationPortail", "administrateur_client", "automatique", []],
      ["invitationCollegue", "collegue_invite", "automatique", []],
      ["cestParti", "administrateur_client", "automatique", []],
      ["lancementEnCours", "administrateur_client", "automatique", []],
      ["lienReconnexion", "administrateur_client", "automatique", ["connexionTesteeEnEchec", "aucunIncidentOuvertSurConnecteur"]],
      ["avisExpirationConnexion7Jours", "administrateur_client", "automatique", []],
      ["brouillonEnAttente", "administrateur_client", "automatique", []],
      ["brouillonExpire", "administrateur_client", "automatique", []],
      ["envoiEnAttenteARelire", "administrateur_client", "automatique", []],
      ["palier80Client", "administrateur_client", "automatique", []],
      ["palier100Client", "administrateur_client", "automatique", []],
      ["palier80Will", "will", "automatique", []],
      ["palier100Will", "will", "automatique", []],
      ["factureDisponible", "administrateur_client", "automatique", []],
      ["relanceImpaye", "administrateur_client", "clic_will", []],
      ["nonPaiement30Jours", "administrateur_client", "clic_will", []],
      ["rapportMensuel", "administrateur_client", "automatique", []],
      ["notificationViolation", "administrateur_client", "clic_will", []],
    ];
    const reel = TABLE_ENVOIS.map((e) => [e.evenement, e.destinataire, e.mode, e.conditions ?? []]);
    expect(reel).toEqual(attendu);
    for (const e of TABLE_ENVOIS) {
      expect(e.interrupteur, e.evenement).toBe(`envoi.${e.evenement}`);
      expect(e.canal, e.evenement).toBe("email");
      expect(e.version, e.evenement).toBe("V1");
    }
  });

  it("[C-557] le bandeau d'incident n'a aucune ligne dans la table : aucun e-mail", () => {
    expect(TABLE_ENVOIS.some((e) => /bandeau/i.test(e.evenement))).toBe(false);
  });
});
