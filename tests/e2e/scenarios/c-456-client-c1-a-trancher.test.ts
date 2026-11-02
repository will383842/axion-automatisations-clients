import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, test } from "vitest";
import { cleDIntention } from "../../../packages/contrats/src/commun/idempotence.ts";
import { creerExpediteur, magasinEnMemoire } from "../../../apps/api/src/canaux/expediteur.ts";
import { creerSigneur } from "../../../apps/api/src/canaux/signer.ts";
import { clientC1 } from "../../../apps/api/src/hub/client-c1.ts";
import { traiterReponse } from "../../../apps/api/src/hub/reponses.ts";
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
  const empreintes = new Map<string, string>();
  const alertes: unknown[] = [];
  const tx = { query: async (t: string) => (/app\.tenant_id/.test(t) ? { rows: [{ tenant }] } : /FROM contacts/.test(t) ? { rows: [{ email: "contact@exemple.fr" }] } : { rows: [] }) };
  const c = clientC1({ tx, gardesSignatureHub: gardes, deposer: async (d) => {
    const cle = cleDIntention("hub", JSON.stringify([tenant, d.intention]));
    const empreinte = createHash("sha256").update(JSON.stringify(d.corps)).digest("hex");
    // Comme boite-envoi.deposer : même clé et autre empreinte de corps = refus.
    if (cles.has(cle)) { if (empreintes.get(cle) !== empreinte) throw new Error("intention déjà déposée avec un autre corps"); return { nouveau: false }; }
    empreintes.set(cle, empreinte); cles.add(cle); magasin.deposer({ tenantId: tenant, destination: "hub", route: d.route, methode: d.methode, corps: d.corps, cle });
    return { nouveau: true };
  } });
  const expediteur = creerExpediteur({ magasin, signeur: creerSigneur({ cles: { cleActive: async () => ({ kid: KID, secret: SECRET }) }, actif: () => true }), urls: { hub: hub.url, crm: hub.url }, alerter: async (a) => void alertes.push(a), aleatoire: () => 0.5 });
  const partir = async () => { for (const l of magasin.lignes()) await expediteur.executer({ tenantId: l.tenantId, id: l.id }); };
  return { c, magasin, partir, tx, alertes };
}
const org = (tenant: string, o: object = {}) => ({ consoleClientId: tenant, raisonSociale: "Atelier Bertin", adresse: ADRESSE, contactFacturation: { nom: "Camille Test", email: "contact@exemple.fr" }, ...o });

test("[C-456] un client sans SIREN qui ressemble à une fiche part dans à trancher et rien n'est créé", async () => {
  const tenant = randomUUID();
  const b = banc(tenant);
  await b.c.retrouverOuCreer(org(tenant, { raisonSociale: "Garage Fontaine" }));
  await b.partir();
  const ligne = b.magasin.lignes()[0]!;
  expect((ligne.reponse as { resultat: string }).resultat).toBe("a_trancher");
  const requetes: string[] = [];
  const r = await traiterReponse({ query: async (t) => (requetes.push(t), { rows: [] }) }, tenant, { route: "clients-retrouver-ou-creer", statut: 202, corps: ligne.reponse });
  expect(r).toEqual({ rangee: "a_trancher" });
  expect(requetes.some((t) => /INSERT INTO organisations|UPDATE organisations/.test(t))).toBe(false);
});
