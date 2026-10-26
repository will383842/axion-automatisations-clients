import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ROUTES_C1, cleDIntention } from "../../packages/contrats/src/index.ts";
import { Fait } from "../../packages/contrats/src/c2/faits.ts";
import { LectureReponse } from "../../packages/contrats/src/c3/lecture-entreprise.ts";
import { envoyerSigne, type Identifiants } from "./hub/client-signe.ts";
import { demarrerBouchonHub, type BouchonHub } from "./hub/serveur.ts";
import { demarrerBouchonCrm, type BouchonCrm } from "./crm/serveur.ts";

const ident: Identifiants = { cle: "cle-test-c1-console-a", secret: "TEST-NE-PAS-UTILISER-cle-c1-console-a" };
const maintenant = () => Math.floor(Date.now() / 1000);
const RETROUVER = "/api/console/v1/clients/retrouver-ou-creer";
const retrouver = (siren: string | undefined, raisonSociale: string) => ({
  consoleClientId: "console-cli-0001",
  ...(siren ? { siren } : {}),
  raisonSociale,
  adresse: { ligne1: "1 rue d'essai", codePostal: "75001", ville: "Ville-Test", pays: "FR" },
  contactFacturation: { nom: "Camille Test", email: "contact@exemple.fr" },
});

let hub: BouchonHub;
let crm: BouchonCrm;
let recus: unknown[] = [];
let recepteur: { url: string; arreter: () => Promise<void> };
beforeAll(async () => {
  hub = await demarrerBouchonHub({
    cles: { [ident.cle]: ident.secret },
    fiches: [
      { siren: "732829320", axiCli: "AXI-CLI-000002", raisonSociale: "Atelier Bertin" },
      { siren: "552100554", axiCli: "AXI-CLI-000003", raisonSociale: "Boulangerie Rivoire", absorbeePar: "AXI-CLI-000002" },
    ],
  });
  crm = await demarrerBouchonCrm({ cles: { [ident.cle]: ident.secret }, entreprises: [{ siren: "732829320", crmCompanyId: "crm-0002", raisonSociale: "Atelier Bertin" }] });
  const { createServer } = await import("node:http");
  const serveur = createServer((req, res) => {
    let corps = "";
    req.on("data", (d: Buffer) => (corps += d.toString()));
    req.on("end", () => {
      recus.push({ chemin: req.url, entetes: req.headers, corps: JSON.parse(corps) });
      res.end("{}");
    });
  });
  await new Promise<void>((ok) => serveur.listen(0, "127.0.0.1", ok));
  const port = (serveur.address() as { port: number }).port;
  recepteur = { url: `http://127.0.0.1:${port}`, arreter: () => new Promise((ok) => serveur.close(() => ok())) };
});
afterAll(async () => {
  await Promise.all([hub.arreter(), crm.arreter(), recepteur.arreter()]);
});

describe("bouchon du Hub", () => {
  it("[C-537] le bouchon du Hub refuse une signature fausse et un rejeu comme le contrat l'écrit", async () => {
    const fausse = await envoyerSigne(hub.url, { ...ident, secret: "TEST-NE-PAS-UTILISER-autre" }, "POST", RETROUVER, retrouver("123456789", "Garage Fontaine"));
    expect([fausse.statut, fausse.corps.erreur.code]).toEqual([401, "signature_invalide"]);
    const options = { horodatage: maintenant(), cleIdempotence: cleDIntention("test", "rejeu") };
    const premier = await envoyerSigne(hub.url, ident, "POST", RETROUVER, retrouver("123456789", "Garage Fontaine"), options);
    const rejeu = await envoyerSigne(hub.url, ident, "POST", RETROUVER, retrouver("123456789", "Garage Fontaine"), options);
    expect([premier.statut, rejeu.statut, rejeu.corps.erreur.code]).toEqual([200, 401, "rejeu"]);
  });

  it("[C-537] même clé, même corps : même réponse et Idempotency-Replayed", async () => {
    const cleIdempotence = cleDIntention("test", "doublon");
    const a = await envoyerSigne(hub.url, ident, "POST", RETROUVER, retrouver("123456789", "Garage Fontaine"), { cleIdempotence, horodatage: maintenant() - 10 });
    const avant = hub.etat().effets.length;
    const b = await envoyerSigne(hub.url, ident, "POST", RETROUVER, retrouver("123456789", "Garage Fontaine"), { cleIdempotence, horodatage: maintenant() - 11 });
    expect(b.entetes.get("Idempotency-Replayed")).toBe("true");
    expect(b.corps).toEqual(a.corps);
    expect(hub.etat().effets.length).toBe(avant);
  });

  it("[C-537] même clé, corps différent : 409 cle_reutilisee", async () => {
    const cleIdempotence = cleDIntention("test", "reutilisee");
    await envoyerSigne(hub.url, ident, "POST", RETROUVER, retrouver("123456789", "Garage Fontaine"), { cleIdempotence, horodatage: maintenant() - 20 });
    const b = await envoyerSigne(hub.url, ident, "POST", RETROUVER, retrouver("123456789", "Atelier Autre"), { cleIdempotence, horodatage: maintenant() - 21 });
    expect([b.statut, b.corps.erreur.code]).toEqual([409, "cle_reutilisee"]);
  });

  it("[C-537] les réponses du bouchon passent les schémas de packages/contrats", async () => {
    const hors = (n: number) => ({ cleIdempotence: cleDIntention("test", `schema-${n}`), horodatage: maintenant() - 30 - n });
    const retrouve = await envoyerSigne(hub.url, ident, "POST", RETROUVER, retrouver("732829320", "Atelier Bertin"), hors(1));
    expect([retrouve.statut, retrouve.corps.resultat, retrouve.corps.axiCli]).toEqual([200, "retrouve", "AXI-CLI-000002"]);
    const trancher = await envoyerSigne(hub.url, ident, "POST", RETROUVER, retrouver(undefined, "Atelier Bertin SARL"), hors(2));
    expect([trancher.statut, trancher.corps.resultat]).toEqual([202, "a_trancher"]);
    const absorbee = await envoyerSigne(hub.url, ident, "POST", RETROUVER, retrouver("552100554", "Boulangerie Rivoire"), hors(3));
    expect([absorbee.statut, absorbee.corps.erreur.code]).toEqual([422, "fiche_absorbee"]);
    const ligne = (tauxTvaBps: number) => ({ referencePropositionConsole: "prop-1", lignes: [{ libelle: "Essai", quantite: 1, prixUnitaireHtCentimes: 123456, activite: "automatisation", tauxTvaBps }] });
    const tva = await envoyerSigne(hub.url, ident, "POST", "/api/console/v1/devis", ligne(550), hors(4));
    expect([tva.statut, tva.corps.erreur.code]).toEqual([422, "tva_interdite"]);
    const devis = await envoyerSigne(hub.url, ident, "POST", "/api/console/v1/devis", ligne(2000), hors(5));
    expect(devis.statut).toBe(201);
    expect(ROUTES_C1.devis.reponses[201].safeParse(devis.corps).success).toBe(true);
    expect(ROUTES_C1["clients-retrouver-ou-creer"].reponses[200].safeParse(retrouve.corps).success).toBe(true);
    expect(ROUTES_C1["clients-retrouver-ou-creer"].reponses[202].safeParse(trancher.corps).success).toBe(true);
  });

  it("[C-537] le bouchon du Hub pousse un fait C2 signé, avec event_id et sequence croissante", async () => {
    const cle = { cle: "cle-test-c2-hub-a", secret: "TEST-NE-PAS-UTILISER-cle-c2-hub-a" };
    const payload = { numeroDevis: "AXI-DEV-000001", date: "2026-10-24" };
    await hub.pousser(`${recepteur.url}/api/hub/v1/faits`, cle, { type: "devis.signe", axiCli: "AXI-CLI-000002", payload });
    await hub.pousser(`${recepteur.url}/api/hub/v1/faits`, cle, { type: "devis.refuse", axiCli: "AXI-CLI-000002", payload });
    const [premier, second] = recus.map((r) => (r as { corps: unknown }).corps);
    expect(Fait.safeParse(premier).success).toBe(true);
    expect((second as { sequence: number }).sequence).toBeGreaterThan((premier as { sequence: number }).sequence);
    expect((recus[0] as { entetes: Record<string, string> }).entetes["x-axion-signature"]).toMatch(/^v1=[0-9a-f]{64}$/);
  });

  it("[LOT2-bouchons] couper() répond 503 porte_fermee", async () => {
    hub.couper();
    const r = await envoyerSigne(hub.url, ident, "POST", RETROUVER, retrouver("123456789", "Garage Fontaine"), { cleIdempotence: cleDIntention("test", "coupe") });
    hub.rouvrir();
    expect([r.statut, r.corps.erreur.code]).toEqual([503, "porte_fermee"]);
  });

  it("[LOT2-bouchons] tuerApresReception() crée la fiche sans répondre", async () => {
    const avant = hub.etat().effets.length;
    hub.tuerApresReception();
    await expect(envoyerSigne(hub.url, ident, "POST", RETROUVER, retrouver("987654321", "Lemoine Rénovation"), { cleIdempotence: cleDIntention("test", "tue") })).rejects.toThrow();
    expect(hub.etat().effets.length).toBe(avant + 1);
    // Le nouvel essai (autre horodatage, même clé) ne recrée rien et rend la réponse perdue.
    const reprise = await envoyerSigne(hub.url, ident, "POST", RETROUVER, retrouver("987654321", "Lemoine Rénovation"), { cleIdempotence: cleDIntention("test", "tue"), horodatage: maintenant() - 40 });
    expect([reprise.statut, reprise.entetes.get("Idempotency-Replayed")]).toEqual([200, "true"]);
    expect(hub.etat().effets.length).toBe(avant + 1);
  });

  it("[LOT2-bouchons] lenteur(ms) retarde la réponse", async () => {
    hub.lenteur(150);
    const debut = Date.now();
    await envoyerSigne(hub.url, ident, "GET", "/api/console/v1/statuts?depuis=0");
    hub.lenteur(0);
    expect(Date.now() - debut).toBeGreaterThanOrEqual(140);
  });
});

describe("bouchon du CRM", () => {
  it("[C-537] le bouchon du CRM lit une entreprise par SIREN et répond 404 introuvable sinon", async () => {
    const ok = await envoyerSigne(crm.url, ident, "GET", "/api/console/v1/entreprises?siren=732829320");
    expect(ok.statut).toBe(200);
    expect(LectureReponse.safeParse(ok.corps).success).toBe(true);
    const non = await envoyerSigne(crm.url, ident, "GET", "/api/console/v1/entreprises?siren=123456782");
    expect([non.statut, non.corps.erreur.code]).toEqual([404, "introuvable"]);
  });

  it("[C-537] le bouchon du CRM pousse consentement.retire et fiche.fusionnee vers la console", async () => {
    recus = [];
    const cle = { cle: "cle-test-c3-crm-a", secret: "TEST-NE-PAS-UTILISER-cle-c3-crm-a" };
    await crm.pousser(`${recepteur.url}/api/hub/v1/crm`, cle, { type: "consentement.retire", crmCompanyId: "crm-0002", payload: { personKey: "personne-1", emailEmpreinte: "a".repeat(64) } });
    await crm.pousser(`${recepteur.url}/api/hub/v1/crm`, cle, { type: "fiche.fusionnee", crmCompanyId: "crm-0002", payload: { crmCompanyIdAbsorbee: "crm-0003", crmCompanyIdGardee: "crm-0002" } });
    expect(recus.map((r) => (r as { corps: { event_type: string } }).corps.event_type)).toEqual(["consentement.retire", "fiche.fusionnee"]);
  });
});
