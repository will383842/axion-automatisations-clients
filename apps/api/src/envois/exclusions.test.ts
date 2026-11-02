import { describe, expect, it } from "vitest";
import { empreinteEmail } from "../../../../packages/contrats/src/c3/evenements-crm-vers-console.js";
import { ENVOIS_COMMERCIAUX, ENVOIS_DE_SERVICE, creerEnvoisCommerciaux } from "./exclusions.js";

const CLIENT = "11111111-1111-4111-8111-111111111111";
const exclues = new Set<string>();
const transport: string[] = [];
const envois = creerEnvoisCommerciaux({
  exclusions: { estExclue: async (client, empreinte) => client === CLIENT && exclues.has(empreinte) },
  transport: { envoyer: async (m) => void transport.push(m.destinataire) },
});

describe("envois commerciaux et exclusions", () => {
  it("[C-458] un envoi commercial vers une adresse exclue est refusé, un envoi de service part toujours", async () => {
    exclues.add(empreinteEmail("Camille.Test@Exemple.fr "));
    const refus = await envois.envoyer({ type: "prospection", clientId: CLIENT, destinataire: "camille.test@exemple.fr" });
    expect(refus).toEqual({ envoye: false, raison: "exclu" });
    const service = await envois.envoyer({ type: "facture", clientId: CLIENT, destinataire: "camille.test@exemple.fr" });
    expect(service).toEqual({ envoye: true });
    expect(transport).toEqual(["camille.test@exemple.fr"]);
  });

  it("[C-458] la liste des envois commerciaux est fermée et nommée ; un type inconnu est refusé", async () => {
    expect(ENVOIS_COMMERCIAUX.length).toBeGreaterThan(0);
    expect(ENVOIS_COMMERCIAUX.filter((t) => (ENVOIS_DE_SERVICE as readonly string[]).includes(t))).toEqual([]);
    await expect(envois.envoyer({ type: "inconnu" as never, clientId: CLIENT, destinataire: "x@exemple.fr" })).rejects.toThrow();
  });

  it("[C-458] un client sans exclusion envoie normalement", async () => {
    const r = await envois.envoyer({ type: "newsletter", clientId: "22222222-2222-4222-8222-222222222222", destinataire: "camille.test@exemple.fr" });
    expect(r).toEqual({ envoye: true });
  });
});
