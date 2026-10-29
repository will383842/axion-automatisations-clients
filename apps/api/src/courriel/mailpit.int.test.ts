import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { creerClientMailpit } from "../../../../packages/harnais/src/mailpit.js";
import { TABLE_ENVOIS, type Envoi } from "../../../../packages/contrats/src/notifications/table.js";
import { creerExpediteur } from "./expediteur.js";
import { creerTransportMailpit } from "./mailpit.js";

const ORANGE: Envoi = { evenement: "alerteOrange", destinataire: "will", canal: "email", mode: "automatique", interrupteur: "envoi.alerteOrange", cleTexte: null, version: "V1", exigence: "B-394" };

describe("expéditeur → Mailpit (CI)", () => {
  const mailpit = creerClientMailpit();
  beforeAll(() => mailpit.attendrePret());
  beforeEach(() => mailpit.vider());

  const monter = (ouvert: boolean) =>
    creerExpediteur({ table: [...TABLE_ENVOIS, ORANGE], transport: creerTransportMailpit({ de: "service@exemple.fr", smtp: mailpit.smtp }), interrupteurs: { ouvert: () => ouvert }, trace: { ecrire: () => {} } });

  it("[B-394] orange → Mailpit reçoit un e-mail qui ne porte que client, automatisation et code d'erreur", async () => {
    await monter(true).envoyer("alerteOrange", { role: "will", adresse: "equipe@exemple.fr" }, { client: "Garage Fontaine", automatisation: "Relance des devis", codeErreur: "E-CONNEXION-401" });
    const [resume] = await mailpit.attendreMessages(1);
    const message = await mailpit.lire(resume!.ID);
    expect(message.To[0]?.Address).toBe("equipe@exemple.fr");
    expect(message.Subject).toContain("Garage Fontaine");
    expect(message.Text).toContain("Relance des devis");
    expect(message.Text).toContain("E-CONNEXION-401");
  });

  it("[A-116] interrupteur fermé → Mailpit ne reçoit rien", async () => {
    await monter(false).envoyer("alerteOrange", { role: "will", adresse: "equipe@exemple.fr" }, { client: "Garage Fontaine", automatisation: "Relance des devis", codeErreur: "E-1" });
    await new Promise((ok) => setTimeout(ok, 500));
    expect(await mailpit.lister()).toHaveLength(0);
  });
});
