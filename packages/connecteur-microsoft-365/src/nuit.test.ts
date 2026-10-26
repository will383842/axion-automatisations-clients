import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { creerJeton } from "@axion-auto/connecteurs-commun";
import { ouvrirMicrosoft365 } from "./connecteur.ts";

// Suite de nuit contre le tenant développeur de test (workflow de nuit, à venir : voir la PR). Sautée partout ailleurs ;
// quand la nuit la demande, un tenant non configuré la rend ROUGE (jamais verte par défaut).
const nuit = process.env["NUIT_CONNECTEURS"] === "1";
const itNuit = nuit ? it : it.skip;
const REQUIS = ["GRAPH_JETON_TEST", "GRAPH_COMPTE_TEST", "GRAPH_DESTINATAIRE_TEST"] as const;
const pause = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

describe("nuit : tenant développeur Microsoft 365", () => {
  itNuit("[A-397] tenant configuré : jeton, compte et destinataire du tenant de test présents", () => {
    const absents = REQUIS.filter((n) => !process.env[n]);
    expect(absents, `tenant de test non configuré : ${absents.join(", ")}`).toEqual([]);
  });

  itNuit("[A-338] envoi réel vers le tenant de test, puis recherche après coup", async () => {
    const [jetonBrut, compte, destinataire] = REQUIS.map((n) => process.env[n] ?? "");
    // N'envoie qu'à une adresse du tenant de test : même domaine que le compte de test.
    expect(destinataire?.split("@")[1]).toBe(compte?.split("@")[1]);
    const connecteur = ouvrirMicrosoft365({ CONNECTEURS_MESSAGERIE_OUVERT: "1" });
    const jeton = creerJeton(jetonBrut ?? "", Date.now() + 30 * 60_000);
    const messageId = `<nuit.${randomUUID()}@${compte?.split("@")[1]}>`;
    await connecteur.envoyer(jeton, { messageId, destinataire: destinataire ?? "", objet: "Essai de nuit", corps: "Essai automatique" });
    let etat = await connecteur.verifierApresCoup(jeton, messageId);
    for (let i = 0; i < 10 && etat !== "trouve"; i++) {
      await pause(3_000);
      etat = await connecteur.verifierApresCoup(jeton, messageId);
    }
    expect(etat).toBe("trouve");
  }, 60_000);
});
