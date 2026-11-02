import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, test } from "vitest";
import { cleDIntention } from "../../../packages/contrats/src/commun/idempotence.ts";
import { creerExpediteur, magasinEnMemoire } from "../../../apps/api/src/canaux/expediteur.ts";
import { creerSigneur } from "../../../apps/api/src/canaux/signer.ts";
import { traiterReponse } from "../../../apps/api/src/hub/reponses.ts";
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

// Chaque variante porte SA donnée distinctive (fiche sans SIREN, client du CRM ressaisi à la main, particulier à l'e-mail changé).
const VARIANTES = [
  { cas: "fiche Hub sans SIREN", extra: { raisonSociale: "Boulangerie Rivoire" } },
  { cas: "client du CRM ressaisi à la main", extra: { raisonSociale: "Garage Fontaine SARL", adresse: { ...ADRESSE, ligne1: "3 rue de la Ressaisie" } } },
  { cas: "particulier dont l'e-mail a changé", extra: { raisonSociale: "Atelier Bertin Garage Fontaine", contactFacturation: { nom: "Camille Test", email: "nouveau@exemple.fr" } } },
] as const;
for (const { cas, extra } of VARIANTES) {
  test(`[C-550] ${cas} : rattachement proposé, rien créé, motif rangé dans à trancher`, async () => {
    const tenant = randomUUID();
    const b = banc(tenant);
    await b.c.retrouverOuCreer(org(tenant, extra));
    await b.partir();
    const ligne = b.magasin.lignes()[0]!;
    const corps = ligne.corps as { raisonSociale: string; adresse: { ligne1: string }; contactFacturation: { email: string } };
    expect(corps.raisonSociale).toBe(extra.raisonSociale);
    if ("adresse" in extra) expect(corps.adresse.ligne1).toBe(extra.adresse.ligne1);
    if ("contactFacturation" in extra) expect(corps.contactFacturation.email).toBe(extra.contactFacturation.email);
    const lue = ligne.reponse as { resultat: string; idDemande: string };
    expect(lue.resultat).toBe("a_trancher");
    // Aucun axiCli rendu : rien n'a été créé ; le statut reste refusé tant que la décision est ouverte (client-c1.test.ts).
    expect(lue).not.toHaveProperty("axiCli");
    // Le motif est rangé dans à trancher avec l'identifiant de la demande, jamais un texte du Hub.
    const requetes: { texte: string; valeurs: unknown[] }[] = [];
    const r = await traiterReponse({ query: async (texte, valeurs = []) => (requetes.push({ texte, valeurs }), { rows: [] }) }, tenant, { route: "clients-retrouver-ou-creer", statut: 202, corps: lue });
    expect(r).toEqual({ rangee: "a_trancher" });
    expect(requetes).toHaveLength(1);
    expect(requetes[0]!.valeurs).toContain("siren_absent_ressemblance");
    expect(String(requetes[0]!.valeurs[2])).toContain(lue.idDemande);
  });
}
