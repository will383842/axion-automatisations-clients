import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleDIntention } from "../../../../packages/contrats/src/commun/idempotence.js";
import { EN_TETES } from "../../../../packages/contrats/src/commun/signature.js";
import { demarrerBouchonCrm, type BouchonCrm } from "../../../../tests/bouchons/crm/serveur.ts";
import { demarrerBouchonHub, type BouchonHub } from "../../../../tests/bouchons/hub/serveur.ts";
import { creerExpediteur, magasinEnMemoire, type AlerteEnvoi, type Destination } from "./expediteur.js";
import { creerRelais, fileEnMemoire } from "./relais.js";
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
  const envoyes: Record<string, string>[] = [];
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
    // Espion : les en-têtes réellement envoyés au bouchon.
    fetch: async (url, init) => { envoyes.push(init?.headers as Record<string, string>); return fetch(url, init); },
  });
  const poser = (n: string, destination: Destination = "hub") => magasin.deposer({ tenantId: TENANT, destination, route: RETROUVER, methode: "POST", corps: corps(n), cle: cleDIntention(destination, `i-${n}`) });
  return { magasin, expediteur, alertes, entetes, envoyes, horloge, poser };
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
    const { poser, expediteur, entetes, envoyes, horloge } = monter();
    const ref = poser(`d${randomUUID().slice(0, 6)}`);
    hub.couper();
    horloge.t = Date.now();
    expect(await expediteur.executer(ref)).toBe("reessai");
    hub.rouvrir();
    horloge.t += 120_000;
    expect(await expediteur.executer(ref)).toBe("envoye");
    expect(entetes[0]?.[EN_TETES.horodatage]).not.toBe(entetes[1]?.[EN_TETES.horodatage]);
    expect(entetes[0]?.[EN_TETES.signature]).not.toBe(entetes[1]?.[EN_TETES.signature]);
    // Ce qui part réellement sur le réseau : même Idempotency-Key, horodatage différent.
    expect(envoyes).toHaveLength(2);
    expect(envoyes[0]?.["Idempotency-Key"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(envoyes[1]?.["Idempotency-Key"]).toBe(envoyes[0]?.["Idempotency-Key"]);
    expect(envoyes[1]?.[EN_TETES.horodatage]).not.toBe(envoyes[0]?.[EN_TETES.horodatage]);
  });

  it("[C-403] après 5 essais, le message est visible dans les échecs", async () => {
    const { magasin, poser, expediteur, horloge, alertes } = monter();
    const ref = poser(`e${randomUUID().slice(0, 6)}`);
    hub.couper();
    const verdicts: string[] = [];
    for (let i = 0; i < 5; i++) { verdicts.push(await expediteur.executer(ref)); horloge.t += 20_000; }
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
    for (let i = 0; i < 5; i++) { await expediteur.executer(ref); horloge.t += 20_000; }
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

  it("[C-402] une file par destination : le CRM coupé ne bloque pas le Hub (relais, deux files)", async () => {
    const { magasin, poser, expediteur, horloge } = monter();
    const executer = async (r: { tenantId: string; id: string }) => void (await expediteur.executer(r));
    const files = { hub: fileEnMemoire(executer), crm: fileEnMemoire(executer) };
    const relais = creerRelais({ magasin, files, ouverte: () => true, maintenant: () => horloge.t });
    crm.couper();
    try {
      const h = poser(`h${randomUUID().slice(0, 6)}`, "hub");
      const c = poser(`i${randomUUID().slice(0, 6)}`, "crm");
      await relais.balayer();
      await Promise.all([files.hub.vider(), files.crm.vider()]);
      expect(magasin.lignes().find((l) => l.id === h.id)?.etat).toBe("envoye");
      const ligneCrm = magasin.lignes().find((l) => l.id === c.id)!;
      expect([ligneCrm.etat, ligneCrm.nombreEssais]).toEqual(["a_envoyer", 1]);
    } finally { crm.rouvrir(); }
  });

  it("[A-088] @envoi le canal fermé par l'interrupteur : la ligne reste à envoyer, sans essai compté", async () => {
    let ouvert = false;
    const { magasin, poser, expediteur, horloge } = monter({ ouvert: () => ouvert });
    const ref = poser(`j${randomUUID().slice(0, 6)}`);
    expect(await expediteur.executer(ref)).toBe("ferme");
    const ligne = magasin.lignes().find((l) => l.id === ref.id)!;
    expect([ligne.etat, ligne.nombreEssais]).toEqual(["a_envoyer", 0]);
    ouvert = true;
    horloge.t += 31_000;
    expect(await expediteur.executer({ ...ref })).toBe("envoye");
  });

  it("[C-535] [C-403] deux essais dans la même seconde portent deux horodatages différents (pas de rejeu 401)", async () => {
    const { magasin, poser, expediteur, entetes } = monter();
    const ref = poser(`h${randomUUID().slice(0, 6)}`);
    hub.tuerApresReception();
    expect(await expediteur.executer(ref)).toBe("reessai");
    // Reprise après arrêt brutal : l'heure du nouvel essai est effacée, le second essai part dans la même seconde.
    delete magasin.lignes().find((l) => l.id === ref.id)!.prochainEssai;
    expect(await expediteur.executer(ref)).toBe("envoye");
    expect(entetes).toHaveLength(2);
    expect(entetes[1]![EN_TETES.horodatage]).not.toBe(entetes[0]![EN_TETES.horodatage]);
    expect(Number(entetes[1]![EN_TETES.horodatage])).toBeGreaterThan(Number(entetes[0]![EN_TETES.horodatage]));
  });

  it("[C-403] la réponse du Hub est bornée avant d'être rangée dans la base", async () => {
    const magasin = magasinEnMemoire();
    const expediteur = creerExpediteur({
      magasin,
      signeur: { signerRequete: async () => ({}) },
      urls: { hub: "http://hub.test", crm: "http://crm.test" },
      alerter: async () => undefined,
      fetch: async () => new Response(JSON.stringify({ grand: "x".repeat(1_000_000) }), { status: 200, headers: { "content-type": "application/json" } }),
    });
    const ref = magasin.deposer({ tenantId: TENANT, destination: "hub", route: RETROUVER, methode: "POST", corps: corps("borne"), cle: cleDIntention("hub", "i-borne") });
    expect(await expediteur.executer(ref)).toBe("envoye");
    const ligne = magasin.lignes().find((l) => l.id === ref.id)!;
    expect(ligne.etat).toBe("envoye");
    expect(JSON.stringify(ligne.reponse).length).toBeLessThan(70_000);
  });
  const reponseHub = (statut: number, code?: string, entetes: Record<string, string> = {}) => async () => new Response(code ? JSON.stringify({ erreur: { code } }) : "{}", { status: statut, headers: { "content-type": "application/json", ...entetes } });
  function monterBouchonne(fetchSimule: typeof fetch, extra: { signeur?: () => Promise<Record<string, string>>; aleatoire?: () => number } = {}) {
    const magasin = magasinEnMemoire();
    const alertes: AlerteEnvoi[] = [];
    const horloge = { t: Date.now() };
    const expediteur = creerExpediteur({ magasin, signeur: { signerRequete: extra.signeur ?? (async () => ({})) }, urls: { hub: "http://hub.test", crm: "http://crm.test" }, alerter: async (a) => void alertes.push(a), maintenant: () => horloge.t, aleatoire: extra.aleatoire ?? (() => 0.5), fetch: fetchSimule });
    const ref = magasin.deposer({ tenantId: TENANT, destination: "hub", route: RETROUVER, methode: "POST", corps: corps("sim"), cle: cleDIntention("hub", `i-${randomUUID()}`) });
    return { magasin, alertes, horloge, expediteur, ref, ligne: () => magasin.lignes().find((l) => l.id === ref.id)! };
  }

  it("[C-403] une réponse 401 horodatage_perime est un nouvel essai, pas un échec définitif", async () => {
    const m = monterBouchonne(reponseHub(401, "horodatage_perime") as unknown as typeof fetch);
    expect(await m.expediteur.executer(m.ref)).toBe("reessai");
    expect([m.ligne().etat, m.ligne().derniereErreur]).toEqual(["a_envoyer", "horodatage_perime"]);
    expect(m.alertes).toEqual([]);
  });

  it("[C-403] une réponse 429 avec Retry-After est un nouvel essai, prochain essai au plus tôt après le Retry-After", async () => {
    const m = monterBouchonne(reponseHub(429, undefined, { "retry-after": "120" }) as unknown as typeof fetch);
    const avant = m.horloge.t;
    expect(await m.expediteur.executer(m.ref)).toBe("reessai");
    expect(m.ligne().etat).toBe("a_envoyer");
    expect(m.ligne().prochainEssai!.getTime()).toBeGreaterThanOrEqual(avant + 120_000);
  });

  it("[C-403] une réponse 400 reste définitive : échec et alerte, sans nouvel essai", async () => {
    const m = monterBouchonne(reponseHub(400, "validation_echouee") as unknown as typeof fetch);
    expect(await m.expediteur.executer(m.ref)).toBe("echec");
    expect(m.alertes.map((a) => a.type)).toEqual(["envoi_en_echec"]);
  });

  it("[A-091] l'attente avant le nouvel essai est d'au moins 1 seconde, même avec un aléa nul", async () => {
    const m = monterBouchonne(reponseHub(503) as unknown as typeof fetch, { aleatoire: () => 0 });
    const avant = m.horloge.t;
    await m.expediteur.executer(m.ref);
    expect(m.ligne().prochainEssai!.getTime() - avant).toBeGreaterThanOrEqual(1000);
  });

  it("[C-403] le signeur lève 6 fois (coffre indisponible) : échec visible et alerte envoi_en_echec, jamais d'essais infinis", async () => {
    const m = monterBouchonne((async () => { throw new Error("ne doit pas être appelé"); }) as unknown as typeof fetch, { signeur: async () => { throw new Error("coffre indisponible"); } });
    const verdicts: string[] = [];
    for (let i = 0; i < 6; i++) { verdicts.push(await m.expediteur.executer(m.ref)); m.horloge.t += 600_000; }
    expect(verdicts.slice(0, 5)).toEqual(["reessai", "reessai", "reessai", "reessai", "echec"]);
    expect(verdicts[5]).toBe("ignore");
    expect([m.ligne().etat, m.ligne().nombreEssais, m.ligne().derniereErreur]).toEqual(["echec", 5, "essais_epuises"]);
    expect(m.alertes.map((a) => a.type)).toEqual(["envoi_en_echec"]);
    expect((await m.magasin.echecs()).map((e) => e.id)).toContain(m.ref.id);
  });

  it("[C-403] la prise ne dépasse jamais le maximum d'essais", async () => {
    const magasin = magasinEnMemoire();
    const ref = magasin.deposer({ tenantId: TENANT, destination: "hub", route: RETROUVER, methode: "POST", corps: corps("max"), cle: cleDIntention("hub", `i-${randomUUID()}`) });
    const t = new Date();
    for (let i = 0; i < 3; i++) { expect(await magasin.prendre(ref, t, 3)).not.toBeNull(); await magasin.reporter(ref, { prochainEssai: t, erreur: "reseau", compter: true }); }
    expect(await magasin.prendre(ref, t, 3)).toBeNull();
  });

  it("[C-403] une ligne reportée dans le futur n'est pas prise avant l'heure du nouvel essai", async () => {
    const magasin = magasinEnMemoire();
    const ref = magasin.deposer({ tenantId: TENANT, destination: "hub", route: RETROUVER, methode: "POST", corps: corps("futur"), cle: cleDIntention("hub", `i-${randomUUID()}`) });
    const t = new Date();
    await magasin.prendre(ref, t);
    await magasin.reporter(ref, { prochainEssai: new Date(t.getTime() + 60_000), erreur: "reseau", compter: true });
    expect(await magasin.prendre(ref, t)).toBeNull();
    expect(await magasin.prendre(ref, new Date(t.getTime() + 60_000))).not.toBeNull();
  });
});
