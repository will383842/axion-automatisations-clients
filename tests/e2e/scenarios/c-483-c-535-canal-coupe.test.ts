import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, test } from "vitest";
import { cleDIntention } from "../../../packages/contrats/src/commun/idempotence.ts";
import { creerExpediteur, magasinEnMemoire, type Destination } from "../../../apps/api/src/canaux/expediteur.ts";
import { creerRelais, fileEnMemoire } from "../../../apps/api/src/canaux/relais.ts";
import { creerSigneur } from "../../../apps/api/src/canaux/signer.ts";
import { demarrerBouchonCrm, type BouchonCrm } from "../../bouchons/crm/serveur.ts";
import { demarrerBouchonHub, type BouchonHub } from "../../bouchons/hub/serveur.ts";

// Scénario « canal coupé » sur les bouchons signés : Hub et CRM arrêtés, 3 demandes en file, reprise, aucune perte, aucun doublon, même clé.
const KID = "emi-e2e";
const SECRET = randomBytes(32);
let hub: BouchonHub;
let crm: BouchonCrm;
beforeAll(async () => {
  hub = await demarrerBouchonHub({ cles: { [KID]: SECRET.toString("base64") } });
  crm = await demarrerBouchonCrm({ cles: { [KID]: SECRET.toString("base64") } });
});
afterAll(async () => void (await Promise.all([hub.arreter(), crm.arreter()])));

const retrouver = (n: number) => ({ consoleClientId: `console-cli-${n}`, raisonSociale: "Atelier Bertin", adresse: { ligne1: "1 rue d'essai", codePostal: "75001", ville: "Ville-Test", pays: "FR" }, contactFacturation: { nom: "Camille Test", email: "contact@exemple.fr" } });

test("[C-483] [C-535] Hub ou CRM arrêtés : file, reprise sans perte ni double envoi, même Idempotency-Key @lot-2", async () => {
  const magasin = magasinEnMemoire();
  const signeur = creerSigneur({ cles: { cleActive: async () => ({ kid: KID, secret: SECRET }) }, actif: () => true });
  const horloge = { t: Date.now() };
  const expediteur = creerExpediteur({ magasin, signeur, urls: { hub: hub.url, crm: crm.url }, alerter: async () => undefined, maintenant: () => horloge.t, aleatoire: () => 0.5 });
  const files = { hub: fileEnMemoire((r) => expediteur.executer(r).then(() => undefined)), crm: fileEnMemoire((r) => expediteur.executer(r).then(() => undefined)) };
  const relais = creerRelais({ magasin, files, ouverte: () => true, maintenant: () => horloge.t });
  const tenant = randomUUID();
  const dest: Destination = "hub";
  for (let n = 1; n <= 3; n++) magasin.deposer({ tenantId: tenant, destination: dest, route: "/api/console/v1/clients/retrouver-ou-creer", methode: "POST", corps: retrouver(n), cle: cleDIntention(dest, `e2e-${n}-${tenant}`) });
  hub.couper();
  const avant = hub.etat().effets.length;
  await relais.balayer(); await files.hub.vider();
  expect(hub.etat().effets.length).toBe(avant);
  hub.rouvrir();
  horloge.t += 5_000;
  await relais.balayer(); await files.hub.vider();
  const lignes = magasin.lignes();
  const cles = hub.etat().effets.slice(avant).map((e) => e.cle);
  expect({ perdues: lignes.filter((l) => l.etat !== "envoye").length, doublons: cles.length - new Set(cles).size, clesIdentiques: [...cles].sort().join() === lignes.map((l) => l.cle).sort().join() }).toEqual({ perdues: 0, doublons: 0, clesIdentiques: true });
});
