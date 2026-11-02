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

for (const [cas, nom] of [["fiche Hub sans SIREN", "Boulangerie Rivoire"], ["client du CRM ressaisi à la main", "Garage Fontaine SARL"], ["particulier dont l'e-mail a changé", "Atelier Bertin Garage Fontaine"]] as const) {
  test(`[C-550] ${cas} : rattachement proposé, rien créé`, async () => {
    const tenant = randomUUID();
    const b = banc(tenant);
    await b.c.retrouverOuCreer(org(tenant, { raisonSociale: nom }));
    await b.partir();
    const lue = b.magasin.lignes()[0]!.reponse as { resultat: string };
    expect(lue.resultat).toBe("a_trancher");
    // Aucun axiCli rendu : rien n'a été créé ; le statut reste refusé tant que la décision est ouverte (client-c1.test.ts).
    expect(lue).not.toHaveProperty("axiCli");
  });
}
