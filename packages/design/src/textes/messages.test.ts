import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type Message, messages } from "./messages.fr.js";
import { CODES_FAUX_MAX, INVITATION_JOURS, LOGO_MO_MAX, MOT_DE_PASSE_MIN, PAUSE_MINUTES, PIECE_JOINTE_MO_MAX } from "./valeurs.js";

const CLES_ATTENDUES = [
  "vide.console.accueilZeroClient",
  "vide.console.accueilJourneeCalme",
  "vide.console.alertes",
  "vide.console.facturation",
  "vide.console.demandes",
  "vide.portail.accueilAvantLancement",
  "vide.portail.accueilPremierMois",
  "vide.portail.aRelire",
  "vide.portail.factures",
  "vide.portail.demandes",
  "erreur.invitationExpiree",
  "erreur.motDePasseFaux",
  "erreur.comptePause",
  "erreur.codeVerificationFaux",
  "erreur.motDePasseTropCourt",
  "erreur.accordAdminMicrosoft",
  "erreur.mauvaisCompteMicrosoft",
  "erreur.envoiRefuseOutlook",
  "erreur.hubInjoignableEmettre",
  "erreur.exportImpossible",
  "erreur.logoRefuse",
  "erreur.pieceJointeTropLourde",
  "erreur.sessionExpiree",
  "erreur.horsLigneTelephone",
  "erreur.brouillonExpire",
  "erreur.horsLigneGeste",
];

const catalogue: Record<string, Message> = messages;
const entrees = Object.entries(catalogue);
const textes = (m: Message) => [m.titre, m.phrase, m.bouton ?? ""];

describe("catalogue des messages", () => {
  it("[C-578] chaque cas listé ci-dessus a une clé", () => {
    for (const cle of CLES_ATTENDUES) expect(messages, cle).toHaveProperty([cle]);
    expect(Object.keys(messages).sort()).toEqual([...CLES_ATTENDUES].sort());
  });

  it("[C-578] aucun texte ne contient « tu », « credential », « webhook », un emoji, « Grenoble »", () => {
    for (const [cle, m] of entrees) {
      for (const t of textes(m)) {
        expect(t, cle).not.toMatch(/(?<![\p{L}])(tu|toi|ton|ta|tes)(?![\p{L}])/iu);
        expect(t, cle).not.toMatch(/credential|webhook|grenoble/i);
        expect(t, cle).not.toMatch(/\p{Extended_Pictographic}/u);
      }
    }
  });

  it("[C-578] chaque erreur a une phrase qui contient un verbe d'action ou un bouton", () => {
    const verbe = /\b(réessay\w+|reconnect\w+|recevez|choisi\w+|envoy\w+|relanc\w+|reprend\w+|patient\w+|demand\w+)\b/i;
    for (const [cle, m] of entrees.filter(([c]) => c.startsWith("erreur."))) {
      expect(Boolean(m.bouton) || verbe.test(m.phrase), cle).toBe(true);
    }
  });

  it("[C-578] chaque état vide a un titre, une phrase et un bouton, sans chiffre en dur", () => {
    for (const [cle, m] of entrees.filter(([c]) => c.startsWith("vide."))) {
      expect(m.titre && m.phrase && m.bouton, cle).toBeTruthy();
    }
  });

  it("[C-581] les valeurs 5, 15, 12, 10 et 7 viennent de constantes uniques", () => {
    expect([CODES_FAUX_MAX, PAUSE_MINUTES, MOT_DE_PASSE_MIN, PIECE_JOINTE_MO_MAX, INVITATION_JOURS]).toEqual([5, 15, 12, 10, 7]);
    expect(LOGO_MO_MAX).toBe(1);
    const source = readFileSync(new URL("./messages.fr.ts", import.meta.url), "utf8");
    expect(source.replace(/^import .*$/gm, "")).not.toMatch(/\d/);
    expect(messages["erreur.comptePause"].phrase).toContain(`${PAUSE_MINUTES} minutes`);
    expect(messages["erreur.comptePause"].titre).toContain(`${CODES_FAUX_MAX} codes`);
    expect(messages["erreur.motDePasseTropCourt"].phrase).toContain(`${MOT_DE_PASSE_MIN} caractères`);
    expect(messages["erreur.pieceJointeTropLourde"].phrase).toContain(`${PIECE_JOINTE_MO_MAX} Mo`);
    expect(messages["erreur.invitationExpiree"].phrase).toContain(`${INVITATION_JOURS} jours`);
  });

  it("[C-578] toute variable utilisée dans un texte est déclarée", () => {
    for (const [cle, m] of entrees) {
      const declarees = new Set<string>(m.variables ?? []);
      const utilisees = textes(m).flatMap((t) => [...t.matchAll(/\{(\w+)\}/g)].map((x) => x[1] as string));
      for (const v of utilisees) expect(declarees.has(v), `${cle} : {${v}}`).toBe(true);
      for (const v of declarees) expect(utilisees, `${cle} : ${v} inutilisée`).toContain(v);
    }
    expect(catalogue["erreur.brouillonExpire"]?.variables).toContain("dureeExpiration");
  });

  it("[C-578] hors ligne : aucun geste mis en file, texte de l'architecte", () => {
    expect(messages["erreur.horsLigneGeste"].phrase).toBe("Vous êtes hors ligne. Rien n'a été envoyé. Réessayez quand le réseau revient.");
  });
});
