import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleDIntention } from "../../../../packages/contrats/src/commun/idempotence.js";
import { EN_TETES } from "../../../../packages/contrats/src/commun/signature.js";
import { demarrerBouchonCrm, type BouchonCrm } from "../../../../tests/bouchons/crm/serveur.ts";
import { demarrerBouchonHub, type BouchonHub } from "../../../../tests/bouchons/hub/serveur.ts";
import { creerExpediteur, magasinEnMemoire, type Destination } from "./expediteur.js";
import { creerSigneur } from "./signer.js";

const RETROUVER = "/api/console/v1/clients/retrouver-ou-creer";
const KID = "emi-essai";
const SECRET = randomBytes(32);
const TENANT = randomUUID();
const corps = (n: string) => ({ consoleClientId: `console-cli-${n}`, raisonSociale: "Atelier Bertin", adresse: { ligne1: "1 rue d'essai", codePostal: "75001", ville: "Ville-Test", pays: "FR" }, contactFacturation: { nom: "Camille Test", email: "contact@exemple.fr" } });
let hub: BouchonHub;
let crm: BouchonCrm;
beforeAll(async () => {
  hub = await demarrerBouchonHub({ cles: { [KID]: SECRET.toString("base64") } });
  crm = await demarrerBouchonCrm({ cles: { [KID]: SECRET.toString("base64") } });
});
afterAll(async () => void (await Promise.all([hub.arreter(), crm.arreter()])));

function monter(surcharge: { ouvert?: () => boolean; horloge?: { t: number } } = {}) {
  const magasin = magasinEnMemoire();
  const alertes: { type: string; cle: string }[] = [];
  const entetes: Record<string, string>[] = [];
  const horloge = surcharge.horloge ?? { t: Date.now() };
  const signeur = creerSigneur({ cles: { cleActive: async () => ({ kid: KID, secret: SECRET }) }, actif: surcharge.ouvert ?? (() => true) });
  const expediteur = creerExpediteur({
    magasin,
    signeur: { signerRequete: async (...a) => { const h = await signeur.signerRequete(...a); entetes.push(h); return h; } },
    urls: { hub: hub.url, crm: crm.url },
    alerter: async (a) => void alertes.push({ type: a.type, cle: a.cle }),
    maintenant: () => horloge.t,
    aleatoire: () => 0.5,
  });
  const poser = (n: string, destination: Destination = "hub") => magasin.deposer({ tenantId: TENANT, destination, route: RETROUVER, methode: "POST", corps: corps(n), cle: cleDIntention(destination, `i-${n}`) });
  return { magasin, expediteur, alertes, entetes, horloge, poser };
}

describe("expéditeur", () => {
  it("[C-535] @anti-doublon la clé est écrite avant le premier essai", async () => {
    const { magasin, poser, expediteur } = monter();
    const ref = poser(`a${randomUUID().slice(0, 6)}`);
    const avant = magasin.lignes().find((l) => l.id === ref.id)!;
    expect([avant.nombreEssais, avant.etat]).toEqual([0, "a_envoyer"]);
    expect(avant.cle).toMatch(/^[0-9a-f-]{36}$/);
    expect(await expediteur.executer(ref)).toBe("envoye");
    expect(magasin.lignes().find((l) => l.id === ref.id)?.cle).toBe(avant.cle);
  });

  it("[C-535] @anti-doublon la console tuée entre l'envoi et la réponse renvoie la MÊME clé et le Hub ne crée rien de plus", async () => {
    const { magasin, poser, expediteur, entetes, horloge } = monter();
    const ref = poser(`b${randomUUID().slice(0, 6)}`);
    const avant = hub.etat().effets.length;
    hub.tuerApresReception();
    expect(await expediteur.executer(ref)).toBe("reessai");
    expect(hub.etat().effets.length).toBe(avant + 1);
    horloge.t += 5_000;
    expect(await expediteur.executer(ref)).toBe("envoye");
    expect(hub.etat().effets.length).toBe(avant + 1);
    const ligne = magasin.lignes().find((l) => l.id === ref.id)!;
    expect(ligne.etat).toBe("envoye");
    expect(entetes).toHaveLength(2);
  });

  it("[C-535] @anti-doublon 10 envois parallèles de la même demande : une seule création", async () => {
    const { magasin, poser, expediteur } = monter();
    const ref = poser(`c${randomUUID().slice(0, 6)}`);
    const avant = hub.etat().effets.length;
    const verdicts = await Promise.all(Array.from({ length: 10 }, () => expediteur.executer(ref)));
    expect(verdicts.filter((v) => v === "envoye")).toHaveLength(1);
    expect(hub.etat().effets.length).toBe(avant + 1);
    expect(magasin.lignes().find((l) => l.id === ref.id)?.etat).toBe("envoye");
  });

  it("[A-091] @envoi chaque essai a un nouvel horodatage et la même clé", async () => {
    const { poser, expediteur, entetes, horloge } = monter();
    const ref = poser(`d${randomUUID().slice(0, 6)}`);
    hub.couper();
    horloge.t = Date.now();
    expect(await expediteur.executer(ref)).toBe("reessai");
    hub.rouvrir();
    horloge.t += 120_000;
    expect(await expediteur.executer(ref)).toBe("envoye");
    expect(entetes[0]?.[EN_TETES.horodatage]).not.toBe(entetes[1]?.[EN_TETES.horodatage]);
    expect(entetes[0]?.[EN_TETES.signature]).not.toBe(entetes[1]?.[EN_TETES.signature]);
  });

  it("[C-403] après 5 essais, le message est visible dans les échecs", async () => {
    const { magasin, poser, expediteur, horloge, alertes } = monter();
    const ref = poser(`e${randomUUID().slice(0, 6)}`);
    hub.couper();
    const verdicts: string[] = [];
    for (let i = 0; i < 5; i++) { verdicts.push(await expediteur.executer(ref)); horloge.t += 5_000; }
    hub.rouvrir();
    expect(verdicts).toEqual(["reessai", "reessai", "reessai", "reessai", "echec"]);
    const echecs = await magasin.echecs();
    expect(echecs.map((e) => e.id)).toContain(ref.id);
    expect(echecs.find((e) => e.id === ref.id)?.nombreEssais).toBe(5);
    expect(alertes.map((a) => a.type)).toContain("envoi_en_echec");
    expect(await expediteur.executer(ref)).toBe("ignore");
  });

  it("[C-403] renvoyer garde la même clé", async () => {
    const { magasin, poser, expediteur, horloge } = monter();
    const ref = poser(`f${randomUUID().slice(0, 6)}`);
    const cle = magasin.lignes().find((l) => l.id === ref.id)!.cle;
    hub.couper();
    for (let i = 0; i < 5; i++) { await expediteur.executer(ref); horloge.t += 5_000; }
    hub.rouvrir();
    expect(await magasin.renvoyer(ref, { acteur: "agent-essai" })).toBe(true);
    const ligne = magasin.lignes().find((l) => l.id === ref.id)!;
    expect([ligne.etat, ligne.cle, ligne.nombreEssais]).toEqual(["a_envoyer", cle, 0]);
    expect(await expediteur.executer(ref)).toBe("envoye");
  });

  it("[C-535] @anti-doublon un 409 cle_reutilisee passe en échec et alerte sans nouvel essai", async () => {
    const { magasin, poser, expediteur, alertes } = monter();
    const n = `g${randomUUID().slice(0, 6)}`;
    const premiere = poser(n);
    expect(await expediteur.executer(premiere)).toBe("envoye");
    // Même clé, corps différent : défaut du producteur.
    const autre = magasin.deposer({ tenantId: TENANT, destination: "hub", route: RETROUVER, methode: "POST", corps: { ...corps(n), raisonSociale: "Garage Fontaine" }, cle: magasin.lignes().find((l) => l.id === premiere.id)!.cle });
    const avant = hub.etat().requetes;
    expect(await expediteur.executer(autre)).toBe("echec");
    expect(hub.etat().requetes).toBe(avant + 1);
    const ligne = magasin.lignes().find((l) => l.id === autre.id)!;
    expect([ligne.etat, ligne.nombreEssais, ligne.derniereErreur]).toEqual(["echec", 1, "cle_reutilisee"]);
    expect(alertes.map((a) => a.type)).toEqual(["cle_reutilisee"]);
  });

  it("[C-402] une file par destination : le CRM coupé ne bloque pas le Hub", async () => {
    const { poser, expediteur } = monter();
    crm.couper();
    try {
      const h = poser(`h${randomUUID().slice(0, 6)}`, "hub");
      const c = poser(`i${randomUUID().slice(0, 6)}`, "crm");
      expect(await expediteur.executer(c)).toBe("reessai");
      expect(await expediteur.executer(h)).toBe("envoye");
    } finally { crm.rouvrir(); }
  });

  it("[A-088] @envoi le canal fermé par l'interrupteur : la ligne reste à envoyer, sans essai compté", async () => {
    let ouvert = false;
    const { magasin, poser, expediteur } = monter({ ouvert: () => ouvert });
    const ref = poser(`j${randomUUID().slice(0, 6)}`);
    expect(await expediteur.executer(ref)).toBe("ferme");
    const ligne = magasin.lignes().find((l) => l.id === ref.id)!;
    expect([ligne.etat, ligne.nombreEssais]).toEqual(["a_envoyer", 0]);
    ouvert = true;
    expect(await expediteur.executer({ ...ref })).toBe("envoye");
  });
});
