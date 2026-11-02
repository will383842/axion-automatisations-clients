import { describe, expect, it } from "vitest";
import { cleDIntention } from "../../../../packages/contrats/src/commun/idempotence.ts";
import { EvenementConsole } from "../../../../packages/contrats/src/c3/evenements-console-vers-crm.ts";
import { emetteurC3, type DepotC3 } from "./emetteur-c3.ts";

const TENANT = "11111111-1111-4111-8111-111111111111";
const AUTRE = "22222222-2222-4222-8222-222222222222";
const QUAND = "2026-10-24T10:00:00Z";

// Faux bouchon : une seule ligne par clé (client + intention), comme la boîte d'envoi (clé anti-doublon incluant le client).
function banc(tenant = TENANT) {
  const lignes = new Map<string, DepotC3>();
  const journal: object[] = [];
  const emetteur = emetteurC3({
    tenantId: tenant,
    deposer: async (d) => {
      const cle = cleDIntention("crm", JSON.stringify([tenant, d.intention]));
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
const corpsDe = (b: ReturnType<typeof banc>) => [...b.lignes.values()].map((d) => d.corps as { event_type: string; event_id: string; payload: Record<string, unknown> });

describe("faits C3 envoyés au CRM", () => {
  it("[C-324] le statut client tenu par la console est recopié dans le CRM", async () => {
    const b = banc();
    await b.emetteur.statutClient(intention("s1"), TENANT, "client");
    await b.emetteur.statutClient(intention("s2"), TENANT, "en_signature");
    await b.emetteur.statutClient(intention("s3"), TENANT, "ancien_client");
    const faits = corpsDe(b);
    expect(faits.map((f) => [f.event_type, f.payload["statut"]])).toEqual([["client.statut", "client"], ["client.statut", "perdu"]]);
  });

  it("[C-346] client.cree, plan.resume, renouvellement.proche, impaye.signale, automatisation.activee, contrat.resilie partent chacun au bon moment", async () => {
    const b = banc();
    await b.emetteur.clientCree(intention("a"), TENANT, "crm-0001");
    await b.emetteur.planResume(intention("b"), TENANT, [{ codeAutomatisation: "tri-courriels", palier: "palier-1", periodeMois: 6, terme: "a_echoir", prochaineEcheance: "2027-04-01" }]);
    await b.emetteur.renouvellementProche(intention("c"), TENANT, "2026-11-23");
    await b.emetteur.impayeSignale(intention("d"), TENANT, 12);
    await b.emetteur.automatisationActivee(intention("e"), TENANT, "tri-courriels", "2026-10-24");
    await b.emetteur.contratResilie(intention("f"), TENANT, "2026-12-31");
    const faits = corpsDe(b);
    expect(faits.map((f) => f.event_type)).toEqual(["client.cree", "plan.resume", "renouvellement.proche", "impaye.signale", "automatisation.activee", "contrat.resilie"]);
    for (const f of faits) expect(EvenementConsole.safeParse(f).success).toBe(true);
    for (const d of b.lignes.values()) expect(d).toMatchObject({ destination: "crm", methode: "POST" });
  });

  it("[C-346] plan.resume ne contient aucun montant", async () => {
    const b = banc();
    const avecMontant = { codeAutomatisation: "tri-courriels", palier: "palier-1", periodeMois: 6, terme: "a_echoir", prochaineEcheance: "2027-04-01", montantCentimes: 1000, prix: 5 };
    await b.emetteur.planResume(intention("p"), TENANT, [avecMontant]);
    const texte = JSON.stringify(corpsDe(b));
    expect(texte).not.toMatch(/montant|prix|centimes|amount|tarif/i);
    expect(corpsDe(b)[0]?.payload["abonnements"]).toEqual([{ codeAutomatisation: "tri-courriels", palier: "palier-1", periodeMois: 6, terme: "a_echoir", prochaineEcheance: "2027-04-01" }]);
  });

  it("[C-346] @anti-doublon le même changement rejoué deux fois donne le même event_id et un seul fait chez le bouchon", async () => {
    const b = banc();
    const un = await b.emetteur.impayeSignale(intention("x"), TENANT, 3);
    const deux = await b.emetteur.impayeSignale(intention("x"), TENANT, 3);
    expect(deux?.eventId).toBe(un?.eventId);
    expect(b.lignes.size).toBe(1);
    expect(deux?.nouveau).toBe(false);
    // Un autre client, même intention : une autre ligne et un autre event_id.
    const c = banc(AUTRE);
    const autre = await c.emetteur.impayeSignale(intention("x"), AUTRE, 3);
    expect(autre?.eventId).not.toBe(un?.eventId);
  });

  it("[C-346] un fait dont les données sont hors contrat n'est jamais déposé", async () => {
    const b = banc();
    await expect(b.emetteur.impayeSignale(intention("n"), TENANT, -1)).rejects.toThrow();
    await expect(b.emetteur.planResume(intention("v"), TENANT, [])).rejects.toThrow();
    expect(b.lignes.size).toBe(0);
  });

  it("[C-344] chaque fait envoyé laisse une ligne au journal du canal, sans corps", async () => {
    const b = banc();
    await b.emetteur.clientCree(intention("j1"), TENANT, "crm-0001");
    await b.emetteur.contratResilie(intention("j2"), TENANT, "2026-12-31");
    expect(b.journal).toHaveLength(2);
    for (const ligne of b.journal) {
      expect(ligne).toMatchObject({ canal: "c3", sens: "sortant", resultat: "depose", id_trace: "trace-0001" });
      expect(JSON.stringify(ligne)).not.toMatch(/crm-0001|payload|corps/);
    }
  });
});
