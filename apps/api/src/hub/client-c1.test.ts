import { describe, expect, it } from "vitest";
import { cleDIntention } from "../../../../packages/contrats/src/commun/idempotence.ts";
import { ROUTES_C1 } from "../../../../packages/contrats/src/c1/routes.ts";
import { clientC1, type DepotHub } from "./client-c1.ts";

const TENANT = "11111111-1111-4111-8111-111111111111";
const AUTRE = "22222222-2222-4222-8222-222222222222";
const AXI = "AXI-CLI-000101";
const ADRESSE = { ligne1: "1 rue d'essai", codePostal: "75001", ville: "Ville-Test", pays: "FR" as const };
const ORG = { consoleClientId: TENANT, siren: "123456782", raisonSociale: "Atelier Bertin", adresse: ADRESSE, contactFacturation: { nom: "Camille Test", email: "contact@exemple.fr" } };
const PHASE = "33333333-3333-4333-8333-333333333333";
const LIGNES = [{ libelle: "Mise en place", quantite: 1, prixUnitaireHtCentimes: 50_000 }];

// Faux bouchon de boîte d'envoi : une ligne par clé (client de la TRANSACTION + intention), comme boite-envoi.deposer.
function banc(opts: { aTrancher?: boolean; email?: string | null; txTenant?: string; gardes?: boolean } = {}) {
  const txTenant = opts.txTenant ?? TENANT;
  const lignes = new Map<string, DepotHub>();
  const tx = {
    query: async (texte: string) => {
      if (/app\.tenant_id/.test(texte)) return { rows: [{ tenant: txTenant }] };
      if (/FROM a_trancher/.test(texte)) return { rows: opts.aTrancher ? [{ un: 1 }] : [] };
      if (/FROM contacts/.test(texte)) return { rows: opts.email === null ? [] : [{ email: opts.email ?? "contact@exemple.fr" }] };
      return { rows: [] };
    },
  };
  const c = clientC1({
    tx,
    gardesSignatureHub: opts.gardes ?? true,
    deposer: async (d) => {
      const cle = cleDIntention("hub", JSON.stringify([txTenant, d.intention]));
      const nouveau = !lignes.has(cle);
      if (nouveau) lignes.set(cle, d);
      return { nouveau };
    },
  });
  return { c, lignes, depots: () => [...lignes.values()] };
}

describe("client C1 vers le Hub", () => {
  it("[C-455] @anti-doublon une même demande envoyée deux fois ne dépose qu'une ligne par intention", async () => {
    const b = banc();
    await b.c.retrouverOuCreer(ORG); await b.c.retrouverOuCreer(ORG);
    await b.c.devis({ axiCli: AXI, consoleClientId: TENANT, referencePropositionConsole: "prop-1", lignes: LIGNES });
    await b.c.devis({ axiCli: AXI, consoleClientId: TENANT, referencePropositionConsole: "prop-1", lignes: LIGNES });
    const plan = { axiCli: AXI, consoleClientId: TENANT, codeAutomatisation: "relance-devis", referenceAbonnementConsole: "abo-1", referenceContratConsole: "ctr-1", phaseId: PHASE, montantHtCentimesParPeriode: 9_000, periodeMois: 1 as const, premiereEcheance: "2026-11-01", engagementMois: 6 };
    await b.c.plan(plan); await b.c.plan(plan);
    expect(b.lignes.size).toBe(3);
  });

  it("[C-455] l'intention est stable : pas d'horodatage ni d'UUID aléatoire dans la clé", async () => {
    const b = banc();
    await b.c.retrouverOuCreer(ORG);
    await b.c.changerStatut({ axiCli: AXI, consoleClientId: TENANT, statut: "client", repere: "h-1" });
    await b.c.devis({ axiCli: AXI, consoleClientId: TENANT, referencePropositionConsole: "prop-1", lignes: LIGNES });
    await b.c.clore({ idPlan: "plan-1", dateFin: "2027-05-01", motif: "fin_engagement" });
    expect(b.depots().map((d) => d.intention)).toEqual([expect.stringMatching(new RegExp(`^retrouver:${TENANT}:[0-9a-f]{32}$`)), `statut:${TENANT}:${AXI}:client_actif:h-1`, "devis:prop-1:r1", "clore:plan-1"]);
  });

  it("[C-363] le SIREN est toujours envoyé quand il est connu, et la route cherche avant de créer", async () => {
    const b = banc();
    await b.c.retrouverOuCreer(ORG);
    const d = b.depots()[0]!;
    expect(d.route).toBe(`/api/console/v1${ROUTES_C1["clients-retrouver-ou-creer"].chemin}`);
    expect((d.corps as { siren?: string }).siren).toBe("123456782");
  });

  it("[C-456] [C-550] un client en attente de décision n'a ni statut, ni devis, ni plan avant la décision", async () => {
    const b = banc({ aTrancher: true });
    await expect(b.c.changerStatut({ axiCli: AXI, consoleClientId: TENANT, statut: "client", repere: "h-x" })).rejects.toThrow(/à trancher/);
    await expect(b.c.devis({ axiCli: AXI, consoleClientId: TENANT, referencePropositionConsole: "p", lignes: LIGNES })).rejects.toThrow(/à trancher/);
    await expect(b.c.plan({ axiCli: AXI, consoleClientId: TENANT, codeAutomatisation: "relance-devis", referenceAbonnementConsole: "abo-1", referenceContratConsole: "ctr-1", phaseId: PHASE, montantHtCentimesParPeriode: 9_000, periodeMois: 1, premiereEcheance: "2026-11-01", engagementMois: 6 })).rejects.toThrow(/à trancher/);
    expect(b.lignes.size).toBe(0);
  });

  it("[C-324] en_signature part au Hub comme prospect, et le passage à client comme client_actif", async () => {
    const b = banc();
    await b.c.changerStatut({ axiCli: AXI, consoleClientId: TENANT, statut: "en_signature", repere: "h-x" });
    await b.c.changerStatut({ axiCli: AXI, consoleClientId: TENANT, statut: "client", repere: "h-x" });
    await b.c.changerStatut({ axiCli: AXI, consoleClientId: TENANT, statut: "ancien_client", repere: "h-x" });
    expect(b.depots().map((d) => (d.corps as { statut: string }).statut)).toEqual(["prospect", "client_actif", "ancien_client"]);
    expect(b.depots()[0]!.route).toBe(`/api/console/v1/clients/${AXI}/statut`);
  });

  it("[C-361] [C-338] l'identifiant console est celui de la transaction : un autre client est refusé", async () => {
    const b = banc({ txTenant: AUTRE });
    await expect(b.c.retrouverOuCreer(ORG)).rejects.toThrow(/client de la transaction/);
    await expect(b.c.changerStatut({ axiCli: AXI, consoleClientId: TENANT, statut: "client", repere: "h-x" })).rejects.toThrow(/client de la transaction/);
    expect(b.lignes.size).toBe(0);
  });

  it("[C-455] @argent un devis part avec activite automatisation et 2000 points de base de TVA, en centimes entiers", async () => {
    const b = banc();
    await b.c.devis({ axiCli: AXI, consoleClientId: TENANT, referencePropositionConsole: "prop-2", lignes: [{ ...LIGNES[0]!, tauxTvaBps: 550, activite: "formation" } as never] });
    const lignes = (b.depots()[0]!.corps as { lignes: { activite: string; tauxTvaBps: number; prixUnitaireHtCentimes: number }[] }).lignes;
    expect(lignes).toEqual([{ libelle: "Mise en place", quantite: 1, prixUnitaireHtCentimes: 50_000, activite: "automatisation", tauxTvaBps: 2000 }]);
    await expect(b.c.devis({ axiCli: AXI, consoleClientId: TENANT, referencePropositionConsole: "prop-3", lignes: [{ ...LIGNES[0]!, prixUnitaireHtCentimes: 10.5 }] })).rejects.toThrow();
    await expect(b.c.devis({ axiCli: AXI, consoleClientId: TENANT, referencePropositionConsole: "prop-4", lignes: [{ ...LIGNES[0]!, prixUnitaireHtCentimes: 2 ** 53 }] })).rejects.toThrow();
  });

  it("[C-455] un POST /devis sans e-mail de contact est refusé avant la boîte d'envoi", async () => {
    const b = banc({ email: null });
    await expect(b.c.devis({ axiCli: AXI, consoleClientId: TENANT, referencePropositionConsole: "p", lignes: LIGNES })).rejects.toThrow(/ajoutez l'e-mail du contact avant de créer le devis/);
    expect(b.lignes.size).toBe(0);
  });

  it("[C-455] un numéro de révision distinct dépose une ligne distincte (la révision côté Hub reste la dette LOT2-dette-T2-15-devis-reel)", async () => {
    const b = banc();
    await b.c.devis({ axiCli: AXI, consoleClientId: TENANT, referencePropositionConsole: "prop-5", lignes: LIGNES });
    await b.c.devis({ axiCli: AXI, consoleClientId: TENANT, referencePropositionConsole: "prop-5", revision: 2, lignes: LIGNES });
    expect(b.depots().map((d) => d.intention)).toEqual(["devis:prop-5:r1", "devis:prop-5:r2"]);
  });

  it("[C-324] aucun appel réel à POST /devis tant que la version du Hub lue ne déclare pas les gardes de signature", async () => {
    const b = banc({ gardes: false });
    await expect(b.c.devis({ axiCli: AXI, consoleClientId: TENANT, referencePropositionConsole: "p", lignes: LIGNES })).rejects.toThrow(/gardes de signature/);
    expect(b.lignes.size).toBe(0);
  });

  it("[C-455] @argent un plan récurrent a UNE intention par phase : même phase deux fois ou deux périodes = une seule ligne", async () => {
    const b = banc();
    const base = { axiCli: AXI, consoleClientId: TENANT, codeAutomatisation: "relance-devis", referenceAbonnementConsole: "abo-1", referenceContratConsole: "ctr-1", phaseId: PHASE, montantHtCentimesParPeriode: 9_000, periodeMois: 1 as const, engagementMois: 6 };
    await b.c.plan({ ...base, premiereEcheance: "2026-11-01" }); await b.c.plan({ ...base, premiereEcheance: "2026-11-01" }); await b.c.plan({ ...base, premiereEcheance: "2026-12-01" });
    expect(b.depots().map((d) => d.intention)).toEqual([`plan:${PHASE}`]);
    await b.c.plan({ ...base, phaseId: "44444444-4444-4444-8444-444444444444", premiereEcheance: "2026-12-01" });
    expect(b.lignes.size).toBe(2);
    expect(JSON.stringify(b.depots()[0]!.corps)).not.toMatch(/phaseId|debutPeriode/);
  });

  it("[C-324] [C-455] réactivation : client, ancien_client, client = 3 lignes ; même statut vers deux axiCli = 2 lignes", async () => {
    const b = banc();
    for (const [statut, repere] of [["client", "h-1"], ["ancien_client", "h-2"], ["client", "h-3"]] as const) {
      await b.c.changerStatut({ axiCli: AXI, consoleClientId: TENANT, statut, repere }); await b.c.changerStatut({ axiCli: AXI, consoleClientId: TENANT, statut, repere });
    }
    expect(b.lignes.size).toBe(3);
    const c = banc();
    await c.c.changerStatut({ axiCli: AXI, consoleClientId: TENANT, statut: "client", repere: "h-1" });
    await c.c.changerStatut({ axiCli: "AXI-CLI-000102", consoleClientId: TENANT, statut: "client", repere: "h-1" });
    expect(c.lignes.size).toBe(2);
  });

  it("[C-456] après une décision tranchée, une nouvelle recherche est une nouvelle ligne ; sans changement, une seule", async () => {
    const b = banc();
    await b.c.retrouverOuCreer(ORG); await b.c.retrouverOuCreer(ORG);
    expect(b.lignes.size).toBe(1);
    await b.c.retrouverOuCreer({ ...ORG, decisionId: "decision-1" } as never);
    await b.c.retrouverOuCreer({ ...ORG, decisionId: "decision-1" } as never);
    expect(b.lignes.size).toBe(2);
    await b.c.retrouverOuCreer({ ...ORG, siren: "987654324" });
    await b.c.retrouverOuCreer({ ...ORG, raisonSociale: "Atelier Bertin et Fils" });
    expect(b.lignes.size).toBe(4);
    expect(JSON.stringify(b.depots().map((d) => d.corps))).not.toMatch(/decisionId/);
  });

  it("[C-324] [C-455] un axiCli mal formé est refusé pour le statut et le devis, avant la boîte d'envoi", async () => {
    const b = banc();
    for (const mauvais of ["", "../x", "AXI-CLI-12", "axi-cli-000101", "AXI-CLI-000101/statut"]) {
      await expect(b.c.changerStatut({ axiCli: mauvais, consoleClientId: TENANT, statut: "client", repere: "h-1" })).rejects.toThrow(/axiCli/);
      await expect(b.c.devis({ axiCli: mauvais, consoleClientId: TENANT, referencePropositionConsole: "p", lignes: LIGNES })).rejects.toThrow(/axiCli/);
    }
    expect(b.lignes.size).toBe(0);
  });

  it("[C-338] aucune lecture de la table de prospection d'axion-ia dans les fichiers du client C1", async () => {
    const { readFileSync } = await import("node:fs");
    for (const f of ["client-c1.ts", "reponses.ts", "apporteurs.ts"]) {
      const source = readFileSync(new URL(`./${f}`, import.meta.url), "utf8");
      expect(source).not.toMatch(/prospect(ion)?s?\b(?!")\s*(WHERE|FROM)|FROM\s+prospect/i);
    }
  });
});
