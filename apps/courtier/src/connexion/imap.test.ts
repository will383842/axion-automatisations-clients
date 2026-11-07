import { describe, expect, it } from "vitest";
import { creerJournal } from "../journal.js";
import { relierImap, type PortsImap } from "./imap.js";

// Attaques prévues (audit) : 1 mot de passe dans une réponse, un journal ou une trace d'état ; 2 hôte de Google sans attestation ;
// 3 port ou chiffrement hors liste ; 4 deux envois du même formulaire ; 5 écriture au coffre avant la réclamation.
const T = "11111111-1111-4111-8111-111111111111";
const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const MARQUEUR = "marqueur-mot-de-passe-imap-7c41";
const FORMULAIRE = { hote: "imap.exemple.fr", port: 993, chiffrement: "tls", identifiant: "contact@exemple.fr", mot_de_passe: MARQUEUR };
const JETONS = `clients/${T}/connexions/${C}/jetons`;
const COMPTE = `clients/${T}/connexions/${C}/compte`;

function monde(sur: Partial<PortsImap> = {}, outil = "imap") {
  const etat = { appels: [] as string[], coffre: new Map<string, Record<string, unknown>>(), lignes: [] as string[], etats: [] as unknown[][], essais: [] as unknown[] };
  const ports: PortsImap = {
    porte: () => true,
    reclamer: async () => (etat.appels.push("reclamer"), true),
    ecrireCoffre: async (chemin, valeur) => { etat.appels.push(`coffre:${chemin}`); etat.coffre.set(chemin, { ...valeur }); },
    testerImap: async (compte, motDePasse) => { etat.appels.push("tester"); etat.essais.push([compte, motDePasse === MARQUEUR]); return { ok: true }; },
    marquerEtat: async (...a) => { etat.appels.push("etat"); etat.etats.push(a); },
    journal: creerJournal((l) => etat.lignes.push(l)),
    ...sur,
  };
  const relier = (formulaire: unknown) => relierImap(ports, { tenantId: T, connexionId: C, outil, acteur: "agent-essai" }, formulaire);
  return { etat, relier };
}

describe("connexion IMAP (formulaire du courtier)", () => {
  it("[A-390] le mot de passe d'application part au coffre dans la même requête : ni base, ni réponse, ni journal (marqueur)", async () => {
    const { etat, relier } = monde();
    const reponse = await relier(FORMULAIRE);
    expect(reponse).toEqual({ etat: "active", code: "ok" });
    expect(etat.appels).toEqual(["reclamer", `coffre:${JETONS}`, `coffre:${COMPTE}`, "tester", "etat"]);
    expect(etat.coffre.get(JETONS)).toEqual({ mot_de_passe: MARQUEUR });
    expect(etat.coffre.get(COMPTE)).toEqual({ hote: "imap.exemple.fr", port: 993, chiffrement: "tls", identifiant: "contact@exemple.fr" });
    expect(etat.essais).toEqual([[{ hote: "imap.exemple.fr", port: 993, chiffrement: "tls", identifiant: "contact@exemple.fr" }, true]]);
    for (const ailleurs of [JSON.stringify(reponse), etat.lignes.join("\n"), JSON.stringify(etat.etats), JSON.stringify(etat.coffre.get(COMPTE))]) expect(ailleurs).not.toContain(MARQUEUR);
    expect(etat.lignes.length).toBeGreaterThan(0);
  });

  it("[A-390] hôte IMAP de Google sur une connexion sans attestation Workspace : refusé, rien au coffre", async () => {
    for (const hote of ["imap.gmail.com", "IMAP.GMAIL.COM", "imap.googlemail.com", "x.imap.googlemail.com"]) {
      const { etat, relier } = monde();
      expect(await relier({ ...FORMULAIRE, hote })).toEqual({ etat: "refusee", code: "attestation_absente" });
      expect(etat.appels).toEqual([]);
      expect(etat.coffre.size).toBe(0);
    }
    // Témoin : sur une connexion « gmail » (attestation tracée à la création du lien), le même hôte passe.
    const { etat, relier } = monde({}, "gmail");
    expect((await relier({ ...FORMULAIRE, hote: "imap.gmail.com" })).etat).toBe("active");
    expect(etat.coffre.has(JETONS)).toBe(true);
  });

  it("[A-390] port ou chiffrement hors liste (143 sans STARTTLS, 25, 110) : refusé avant tout appel", async () => {
    const mauvais = [{ port: 143, chiffrement: "tls" }, { port: 993, chiffrement: "starttls" }, { port: 25, chiffrement: "tls" }, { port: 110, chiffrement: "starttls" }, { port: 465, chiffrement: "tls" }, { port: "993", chiffrement: "tls" }, { port: 143, chiffrement: "aucun" }];
    for (const m of mauvais) {
      const { etat, relier } = monde();
      expect(await relier({ ...FORMULAIRE, ...m })).toEqual({ etat: "refusee", code: "formulaire_invalide" });
      expect(etat.appels).toEqual([]);
    }
    const { etat, relier } = monde();
    expect((await relier({ ...FORMULAIRE, port: 143, chiffrement: "starttls" })).etat).toBe("active");
    expect(etat.coffre.get(COMPTE)).toMatchObject({ port: 143, chiffrement: "starttls" });
  });

  it("[A-390] formulaire non strict (champ en trop, hôte douteux, mot de passe vide ou à sauts de ligne) : refusé avant tout appel", async () => {
    const mauvais = [{ extra: "x" }, { hote: "exemple.fr/chemin" }, { hote: "localhost:993" }, { hote: "" }, { mot_de_passe: "" }, { mot_de_passe: `a\nb` }, { mot_de_passe: "x".repeat(257) }, { identifiant: "" }];
    for (const m of mauvais) {
      const { etat, relier } = monde();
      expect(await relier({ ...FORMULAIRE, ...m })).toEqual({ etat: "refusee", code: "formulaire_invalide" });
      expect(etat.appels).toEqual([]);
    }
    const { etat, relier } = monde();
    expect((await relier(null)).code).toBe("formulaire_invalide");
    expect(etat.appels).toEqual([]);
  });

  it("[A-390] outil dont la porte est fermée : refus porte_fermee, rien au coffre", async () => {
    const { etat, relier } = monde({ porte: () => false });
    expect(await relier(FORMULAIRE)).toEqual({ etat: "refusee", code: "porte_fermee" });
    expect(etat.appels).toEqual([]);
  });

  it("[A-390] la réclamation passe avant le coffre ; réclamation perdue : deja_utilise, rien au coffre", async () => {
    const { etat, relier } = monde({ reclamer: async () => false });
    expect(await relier(FORMULAIRE)).toEqual({ etat: "refusee", code: "deja_utilise" });
    expect(etat.coffre.size).toBe(0);
  });

  it("[A-390] écriture au coffre en échec : connexion en_echec, code ecriture_echouee, aucune valeur dans la trace", async () => {
    const { etat, relier } = monde({ ecrireCoffre: async () => { throw new Error(`coffre indisponible ${MARQUEUR}`); } });
    expect(await relier(FORMULAIRE)).toEqual({ etat: "en_echec", code: "ecriture_echouee" });
    expect(etat.etats).toEqual([[T, C, "agent-essai", "en_echec", "ecriture_echouee"]]);
    expect(JSON.stringify(etat.etats) + etat.lignes.join("")).not.toContain(MARQUEUR);
  });

  it("[A-390] test immédiat refusé ou trop long : en_echec avec son code, aucune valeur journalisée", async () => {
    const refus = monde({ testerImap: async () => ({ ok: false, code: "refuse_401" }) });
    expect(await refus.relier(FORMULAIRE)).toEqual({ etat: "en_echec", code: "refuse_401" });
    const lent = monde({ testerImap: () => new Promise(() => undefined), planifier: (f) => { queueMicrotask(f); return () => undefined; } });
    expect(await lent.relier(FORMULAIRE)).toEqual({ etat: "en_echec", code: "delai" });
    expect(refus.etat.lignes.join("") + lent.etat.lignes.join("")).not.toContain(MARQUEUR);
  });
});
