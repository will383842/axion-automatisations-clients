import { describe, expect, it } from "vitest";
import { cleDIntention } from "../../../../packages/contrats/src/commun/idempotence.ts";
import { EvenementConsole } from "../../../../packages/contrats/src/c3/evenements-console-vers-crm.ts";
import { emetteurC3, type DepotC3 } from "./emetteur-c3.ts";

const TENANT = "11111111-1111-4111-8111-111111111111";
const AUTRE = "22222222-2222-4222-8222-222222222222";
const QUAND = "2026-10-24T10:00:00Z";

// Faux bouchon : une seule ligne par clé (client + intention), comme la boîte d'envoi. Le client de la clé est celui de la TRANSACTION (txTenant),
// jamais celui de l'émetteur : comme le vrai dépôt, qui lit app.tenant_id.
function banc(tenant = TENANT, txTenant: string | null = tenant) {
  const lignes = new Map<string, DepotC3>();
  const journal: object[] = [];
  const tx = { query: async () => ({ rows: [{ tenant: txTenant }] }) };
  const emetteur = emetteurC3({
    tenantId: tenant,
    tx,
    deposer: async (d) => {
      const cle = cleDIntention("crm", JSON.stringify([txTenant, d.intention]));
      const nouveau = !lignes.has(cle);
      if (nouveau) lignes.set(cle, d);
      return { nouveau };
    },
    journal: { info: (l) => void journal.push(l) },
    idTrace: "trace-0001",
  });
  return { emetteur, lignes, journal };
}
const intention = (id: string) => ({ id, occurredAt: QUAND });
const intentionStatut = (id: string, sequence: number) => ({ id, occurredAt: QUAND, sequence });
const corpsDe = (b: ReturnType<typeof banc>) => [...b.lignes.values()].map((d) => d.corps as { event_type: string; event_id: string; payload: Record<string, unknown> });

describe("faits C3 envoyés au CRM", () => {
  it("[C-324] le statut client tenu par la console est recopié dans le CRM", async () => {
    const b = banc();
    await b.emetteur.statutClient(intentionStatut("s1", 1), "client");
    await b.emetteur.statutClient(intentionStatut("s2", 2), "en_signature");
    await b.emetteur.statutClient(intentionStatut("s3", 3), "ancien_client");
    const faits = corpsDe(b);
    expect(faits.map((f) => [f.event_type, f.payload["statut"]])).toEqual([["client.statut", "client"], ["client.statut", "perdu"]]);
  });

  it("[C-346] client.cree, plan.resume, renouvellement.proche, impaye.signale, automatisation.activee, contrat.resilie partent chacun au bon moment", async () => {
    const b = banc();
    await b.emetteur.clientCree(intention("a"), "crm-0001");
    await b.emetteur.planResume(intention("b"), [{ codeAutomatisation: "tri-courriels", palier: "palier-1", periodeMois: 6, terme: "a_echoir", prochaineEcheance: "2027-04-01" }]);
    await b.emetteur.renouvellementProche(intention("c"), "2026-11-23");
    await b.emetteur.impayeSignale(intention("d"), 12);
    await b.emetteur.automatisationActivee(intention("e"), "tri-courriels", "2026-10-24");
    await b.emetteur.contratResilie(intention("f"), "2026-12-31");
    const faits = corpsDe(b);
    expect(faits.map((f) => f.event_type)).toEqual(["client.cree", "plan.resume", "renouvellement.proche", "impaye.signale", "automatisation.activee", "contrat.resilie"]);
    for (const f of faits) expect(EvenementConsole.safeParse(f).success).toBe(true);
    for (const d of b.lignes.values()) expect(d).toMatchObject({ destination: "crm", methode: "POST" });
  });

  it("[C-346] plan.resume ne contient aucun montant", async () => {
    const b = banc();
    const avecMontant = { codeAutomatisation: "tri-courriels", palier: "palier-1", periodeMois: 6, terme: "a_echoir", prochaineEcheance: "2027-04-01", montantCentimes: 1000, prix: 5 };
    await b.emetteur.planResume(intention("p"), [avecMontant]);
    const texte = JSON.stringify(corpsDe(b));
    expect(texte).not.toMatch(/montant|prix|centimes|amount|tarif/i);
    expect(corpsDe(b)[0]?.payload["abonnements"]).toEqual([{ codeAutomatisation: "tri-courriels", palier: "palier-1", periodeMois: 6, terme: "a_echoir", prochaineEcheance: "2027-04-01" }]);
  });

  it("[C-346] @anti-doublon le même changement rejoué deux fois donne le même event_id et un seul fait chez le bouchon", async () => {
    const b = banc();
    const un = await b.emetteur.impayeSignale(intention("x"), 3);
    const deux = await b.emetteur.impayeSignale(intention("x"), 3);
    expect(deux?.eventId).toBe(un?.eventId);
    expect(b.lignes.size).toBe(1);
    expect(deux?.nouveau).toBe(false);
    // Un autre client, même intention : une autre ligne et un autre event_id.
    const c = banc(AUTRE);
    const autre = await c.emetteur.impayeSignale(intention("x"), 3);
    expect(autre?.eventId).not.toBe(un?.eventId);
  });

  it("[C-346] un fait dont les données sont hors contrat n'est jamais déposé", async () => {
    const b = banc();
    await expect(b.emetteur.impayeSignale(intention("n"), -1)).rejects.toThrow();
    await expect(b.emetteur.planResume(intention("v"), [])).rejects.toThrow();
    expect(b.lignes.size).toBe(0);
  });

  it("[C-346] @isolation émetteur A, transaction B : le fait est refusé, rien n'est déposé ni journalisé", async () => {
    const b = banc(TENANT, AUTRE);
    await expect(b.emetteur.impayeSignale(intention("i1"), 3)).rejects.toThrow(/client/);
    await expect(b.emetteur.clientCree(intention("i2"), "crm-0001")).rejects.toThrow(/client/);
    expect(b.lignes.size).toBe(0);
    expect(b.journal).toHaveLength(0);
  });

  it("[C-346] @isolation aucune transaction de client ouverte : le fait est refusé", async () => {
    const b = banc(TENANT, null);
    await expect(b.emetteur.impayeSignale(intention("i3"), 3)).rejects.toThrow(/aucune transaction/);
    expect(b.lignes.size).toBe(0);
  });

  it("[C-346] le client du fait vient de la transaction : le corps porte subject_ref et payload du client lu en base", async () => {
    const b = banc();
    await b.emetteur.clientCree(intention("t1"), "crm-0001");
    const corps = [...b.lignes.values()][0]?.corps as { subject_ref: { consoleClientId: string }; payload: { consoleClientId: string } };
    expect([corps.subject_ref.consoleClientId, corps.payload.consoleClientId]).toEqual([TENANT, TENANT]);
  });

  it("[C-346] @anti-doublon deux clients, même fait, même date : deux intentions et deux event_id différents, jamais une collision", async () => {
    const a = banc(TENANT);
    const c = banc(AUTRE);
    const ra = await a.emetteur.renouvellementProche(intention("renouvellement:2026-11-23"), "2026-11-23");
    const rc = await c.emetteur.renouvellementProche(intention("renouvellement:2026-11-23"), "2026-11-23");
    const ia = [...a.lignes.values()][0]?.intention;
    const ic = [...c.lignes.values()][0]?.intention;
    expect(ia).toBe(`c3:${TENANT}:renouvellement.proche:renouvellement:2026-11-23`);
    expect(ic).toBe(`c3:${AUTRE}:renouvellement.proche:renouvellement:2026-11-23`);
    expect(ra.eventId).not.toBe(rc.eventId);
  });

  it("[C-324] le numéro de séquence du statut est obligatoire et part dans le fait", async () => {
    const b = banc();
    // @ts-expect-error la séquence est obligatoire pour un statut
    await b.emetteur.statutClient(intention("sq0"), "client");
    await b.emetteur.statutClient(intentionStatut("sq1", 7), "client");
    expect(corpsDe(b).at(-1)).toMatchObject({ sequence: 7 });
  });

  it("[C-344] chaque fait laisse une ligne au journal du canal (en attente de validation de la transaction), sans corps", async () => {
    const b = banc();
    await b.emetteur.clientCree(intention("j1"), "crm-0001");
    await b.emetteur.contratResilie(intention("j2"), "2026-12-31");
    expect(b.journal).toHaveLength(2);
    for (const ligne of b.journal) {
      expect(ligne).toMatchObject({ canal: "c3", sens: "sortant", resultat: "en_attente_de_validation", id_trace: "trace-0001" });
      expect(JSON.stringify(ligne)).not.toMatch(/crm-0001|payload|corps/);
    }
  });
});
