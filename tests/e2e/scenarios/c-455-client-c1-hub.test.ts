import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, test } from "vitest";
import { cleDIntention } from "../../../packages/contrats/src/commun/idempotence.ts";
import { creerExpediteur, magasinEnMemoire } from "../../../apps/api/src/canaux/expediteur.ts";
import { creerSigneur } from "../../../apps/api/src/canaux/signer.ts";
import { clientC1 } from "../../../apps/api/src/hub/client-c1.ts";
import { demarrerBouchonHub, type BouchonHub } from "../../bouchons/hub/serveur.ts";

// Client C1 de la console contre le bouchon signé du Hub (T2-13) : mêmes dépôts, même expéditeur, aucun appel réel.
const KID = "emi-e2e";
const SECRET = randomBytes(32);
const ADRESSE = { ligne1: "1 rue d'essai", codePostal: "75001", ville: "Ville-Test", pays: "FR" as const };
let hub: BouchonHub;
const FICHES = [{ siren: "123456782", axiCli: "AXI-CLI-000050", raisonSociale: "Boulangerie Rivoire" }, { siren: "987654321", axiCli: "AXI-CLI-000051", raisonSociale: "Garage Fontaine" }];
beforeAll(async () => { hub = await demarrerBouchonHub({ cles: { [KID]: SECRET.toString("base64") }, fiches: FICHES }); });
afterAll(async () => void (await hub.arreter()));

function banc(tenant: string, gardes = true) {
  const magasin = magasinEnMemoire();
  const cles = new Set<string>();
  const alertes: unknown[] = [];
  const tx = { query: async (t: string) => (/app\.tenant_id/.test(t) ? { rows: [{ tenant }] } : /FROM contacts/.test(t) ? { rows: [{ email: "contact@exemple.fr" }] } : { rows: [] }) };
  const c = clientC1({ tx, gardesSignatureHub: gardes, deposer: async (d) => {
    const cle = cleDIntention("hub", JSON.stringify([tenant, d.intention]));
    if (cles.has(cle)) return { nouveau: false };
    cles.add(cle); magasin.deposer({ tenantId: tenant, destination: "hub", route: d.route, methode: d.methode, corps: d.corps, cle });
    return { nouveau: true };
  } });
  const expediteur = creerExpediteur({ magasin, signeur: creerSigneur({ cles: { cleActive: async () => ({ kid: KID, secret: SECRET }) }, actif: () => true }), urls: { hub: hub.url, crm: hub.url }, alerter: async (a) => void alertes.push(a), aleatoire: () => 0.5 });
  const partir = async () => { for (const l of magasin.lignes()) await expediteur.executer({ tenantId: l.tenantId, id: l.id }); };
  return { c, magasin, partir, tx, alertes };
}
const org = (tenant: string, o: object = {}) => ({ consoleClientId: tenant, raisonSociale: "Atelier Bertin", adresse: ADRESSE, contactFacturation: { nom: "Camille Test", email: "contact@exemple.fr" }, ...o });

test("[C-455] @anti-doublon une même demande envoyée deux fois au Hub ne crée ni deux fiches, ni deux devis, ni deux plans ; la seconde réponse est identique", async () => {
  const tenant = randomUUID();
  const b = banc(tenant);
  const avant = hub.etat().effets.length;
  const plan = { axiCli: "AXI-CLI-000050", consoleClientId: tenant, codeAutomatisation: "relance-devis", referenceAbonnementConsole: "abo-1", referenceContratConsole: "ctr-1", debutPeriode: "2026-11-01", montantHtCentimesParPeriode: 9_000, periodeMois: 1 as const, premiereEcheance: "2026-11-01", engagementMois: 6 };
  const devis = { axiCli: "AXI-CLI-000050", consoleClientId: tenant, referencePropositionConsole: "prop-e2e", lignes: [{ libelle: "Mise en place", quantite: 1, prixUnitaireHtCentimes: 50_000 }] };
  for (let i = 0; i < 2; i++) { await b.c.retrouverOuCreer(org(tenant, { siren: "123456782" })); await b.c.devis(devis); await b.c.plan(plan); }
  await b.partir();
  expect(b.magasin.lignes().map((l) => l.etat)).toEqual(["envoye", "envoye", "envoye"]);
  // La fiche existe déjà (retrouvée, rien créé) ; un seul devis et un seul plan sont notés par le Hub.
  expect(hub.etat().effets.slice(avant).map((e) => e.route)).toEqual(["devis", "plans-recurrents"]);
  expect(b.alertes).toEqual([]);
  // Rejeu de la même ligne (même Idempotency-Key) : le Hub rend la même réponse.
  const premiere = b.magasin.lignes().map((l) => l.reponse);
  b.magasin.lignes().forEach((l) => Object.assign(l, { etat: "a_envoyer", nombreEssais: 0 }));
  await b.partir();
  expect(b.magasin.lignes().map((l) => l.reponse)).toEqual(premiere);
});

test("[C-455] @argent un devis part avec activite automatisation et 2000 points de base de TVA, en centimes entiers", async () => {
  const tenant = randomUUID();
  const b = banc(tenant);
  await b.c.devis({ axiCli: "AXI-CLI-000050", consoleClientId: tenant, referencePropositionConsole: "prop-argent", lignes: [{ libelle: "Mise en place", quantite: 2, prixUnitaireHtCentimes: 12_345 }] });
  await b.partir();
  const ligne = b.magasin.lignes()[0]!;
  expect(ligne.etat).toBe("envoye");
  expect((ligne.corps as { lignes: object[] }).lignes).toEqual([{ libelle: "Mise en place", quantite: 2, prixUnitaireHtCentimes: 12_345, activite: "automatisation", tauxTvaBps: 2000 }]);
});
