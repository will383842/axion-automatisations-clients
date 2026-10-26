import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { envoyerSigne, type Identifiants } from "../bouchons/hub/client-signe.ts";
import { demarrerBouchonCrm, type BouchonCrm } from "../bouchons/crm/serveur.ts";
import { demarrerBouchonHub, type BouchonHub } from "../bouchons/hub/serveur.ts";
import { identifiantEvenementC3 } from "../../packages/contrats/src/c3/evenements-crm-vers-console.ts";
import { EvenementConsole } from "../../packages/contrats/src/c3/evenements-console-vers-crm.ts";
import { lancerSuite, type Cible } from "./canaux.suite.ts";

const ident: Identifiants = { cle: "cle-test-c1-console-a", secret: "TEST-NE-PAS-UTILISER-cle-c1-console-a" };
// CIBLE_RECETTE (lot 1-B) : adresse d'une vraie copie ; clés de recette dans CIBLE_RECETTE_CLE et CIBLE_RECETTE_SECRET.
const recette = process.env.CIBLE_RECETTE;
const identRecette: Identifiants = { cle: process.env.CIBLE_RECETTE_CLE ?? ident.cle, secret: process.env.CIBLE_RECETTE_SECRET ?? ident.secret };

let hub: BouchonHub;
let crm: BouchonCrm;
beforeAll(async () => {
  hub = await demarrerBouchonHub({ cles: { [ident.cle]: ident.secret }, fiches: [{ siren: "732829320", axiCli: "AXI-CLI-000002", raisonSociale: "Atelier Bertin", absorbeePar: "AXI-CLI-000001" }] });
  crm = await demarrerBouchonCrm({ cles: { [ident.cle]: ident.secret }, entreprises: [{ siren: "732829320", crmCompanyId: "crm-0002", raisonSociale: "Atelier Bertin", absorbeePar: "crm-0001" }] });
});
afterAll(async () => {
  await Promise.all([hub.arreter(), crm.arreter()]);
});

describe("suite de comportement partagée", () => {
  it("[C-537] la suite de comportement passe contre le bouchon du Hub", async () => {
    const cible: Cible = {
      url: recette ?? hub.url,
      ident: recette ? identRecette : ident,
      ecriture: {
        chemin: "/api/console/v1/clients/retrouver-ou-creer",
        corps: (v) => ({
          consoleClientId: `console-${v}`,
          siren: "123456789",
          raisonSociale: `Garage Fontaine ${v}`,
          adresse: { ligne1: "1 rue d'essai", codePostal: "75001", ville: "Ville-Test", pays: "FR" },
          contactFacturation: { nom: "Camille Test", email: "contact@exemple.fr" },
        }),
      },
      verifierFusion: async () => {
        const r = await envoyerSigne(recette ?? hub.url, recette ? identRecette : ident, "POST", "/api/console/v1/clients/AXI-CLI-000002/statut", { statut: "client_actif", consoleClientId: "console-fus" }, { cleIdempotence: "11111111-1111-4111-8111-111111111111" });
        expect([r.statut, r.corps.erreur.code]).toEqual([422, "fiche_absorbee"]);
      },
      ...(recette ? {} : { couper: () => hub.couper(), rouvrir: () => hub.rouvrir() }),
    };
    await lancerSuite(cible);
  });

  it("[C-537] la suite de comportement passe contre le bouchon du CRM", async () => {
    const cible: Cible = {
      url: recette ?? crm.url,
      ident: recette ? identRecette : ident,
      ecriture: {
        chemin: "/api/console/v1/evenements",
        corps: (v) =>
          EvenementConsole.parse({
            event_id: identifiantEvenementC3("client.cree", v),
            schema_version: 1,
            occurred_at: "2026-10-24T10:00:00Z",
            emitted_at: "2026-10-24T10:00:01Z",
            sequence: 1,
            producer: "axion-console",
            subject_ref: { consoleClientId: `console-${v}` },
            event_type: "client.cree",
            payload: { consoleClientId: `console-${v}`, crmCompanyId: `crm-${v}` },
          }),
      },
      verifierFusion: async () => {
        const r = await envoyerSigne(recette ?? crm.url, recette ? identRecette : ident, "GET", "/api/console/v1/entreprises?siren=732829320");
        expect([r.statut, r.corps.absorbeePar]).toEqual([200, "crm-0001"]);
      },
      ...(recette ? {} : { couper: () => crm.couper(), rouvrir: () => crm.rouvrir() }),
    };
    await lancerSuite(cible);
  });
});
