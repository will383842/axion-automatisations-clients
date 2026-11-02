import { describe, expect, it } from "vitest";
import { emetteurC3 } from "../crm/emetteur-c3.ts";
import { activerInstance, ErreurRegleMetier, MOTIF_SOUS_TRAITANCE_ABSENTE, type Requeteur } from "./activer.ts";

// Faux client : répond selon la requête ; la base reste la garantie (déclencheur de la migration 0009, essais dans db/contrats.int.test.ts).
const A = "11111111-1111-4111-8111-111111111111";
const I = "22222222-2222-4222-8222-222222222222";
function faux(opts: { instance?: boolean; contrat?: boolean; refusBase?: boolean; majVide?: boolean; dejaActive?: boolean; jour?: string }) {
  const appels: { texte: string; valeurs: unknown[] }[] = [];
  const client: Requeteur = {
    async query(texte, valeurs = []) {
      appels.push({ texte, valeurs });
      if (texte.includes("FROM instances")) {
        // Relecture après une mise à jour vide : l'instance existe encore (déjà active) ou a disparu.
        const relecture = appels.filter((a) => a.texte.includes("FROM instances")).length > 1;
        const presente = opts.instance !== false && !(relecture && opts.majVide && !opts.dejaActive);
        return { rows: presente ? [{ organisation_id: A, code_automatisation: "tri-courriels" }] : [], rowCount: presente ? 1 : 0 };
      }
      if (texte.includes("FROM contrats")) return { rows: opts.contrat ? [{ un: 1 }] : [], rowCount: opts.contrat ? 1 : 0 };
      if (opts.refusBase) throw Object.assign(new Error("regle_metier"), { code: "P0001", detail: MOTIF_SOUS_TRAITANCE_ABSENTE });
      const vide = opts.majVide === true || opts.dejaActive === true;
      return { rows: vide ? [] : [{ jour: opts.jour ?? "2026-11-02" }], rowCount: vide ? 0 : 1 };
    },
  };
  return { client, appels };
}

describe("activer une instance", () => {
  it("[C-030] l'activation d'une instance est refusée tant que le contrat de sous-traitance du client n'est pas signé", async () => {
    const { client, appels } = faux({ contrat: false });
    const erreur = await activerInstance(client, A, I).catch((e: unknown) => e);
    expect(erreur).toBeInstanceOf(ErreurRegleMetier);
    expect(erreur).toMatchObject({ code: "regle_metier", motif: "sous_traitance_absente" });
    expect((erreur as Error).message).toMatch(/contrat de sous-traitance/);
    expect(appels.some((a) => a.texte.startsWith("UPDATE"))).toBe(false);
  });

  it("[C-030] @isolation la recherche du contrat est limitée au client et à l'organisation de l'instance, type sous-traitance, signé", async () => {
    const { client, appels } = faux({ contrat: true });
    await activerInstance(client, A, I);
    const recherche = appels.find((a) => a.texte.includes("FROM contrats"));
    expect(recherche?.texte).toMatch(/tenant_id = \$1/);
    expect(recherche?.texte).toMatch(/organisation_id = \$2/);
    expect(recherche?.texte).toContain("'sous_traitance_art28'");
    expect(recherche?.texte).toMatch(/date_signature <= current_date/);
    expect(recherche?.valeurs).toEqual([A, A]);
    expect(appels.find((a) => a.texte.startsWith("UPDATE"))?.valeurs).toEqual([A, I]);
  });

  it("[C-030] un contrat de sous-traitance révoqué ne compte pas pour l'activation", async () => {
    const { client, appels } = faux({ contrat: true });
    await activerInstance(client, A, I);
    expect(appels.find((a) => a.texte.includes("FROM contrats"))?.texte).toMatch(/revoque_le IS NULL/);
  });

  it("[C-030] une mise à jour qui ne touche aucune ligne (instance disparue entre la lecture et l'écriture) est refusée, jamais prise pour un succès", async () => {
    const { client } = faux({ contrat: true, majVide: true });
    await expect(activerInstance(client, A, I)).rejects.toMatchObject({ code: "regle_metier", motif: "instance_introuvable" });
  });

  it("[C-030] si la base refuse quand même (course), l'erreur de la base devient la même erreur de règle métier", async () => {
    const { client } = faux({ contrat: true, refusBase: true });
    await expect(activerInstance(client, A, I)).rejects.toMatchObject({ code: "regle_metier", motif: "sous_traitance_absente" });
  });

  it("[C-030] une instance inconnue est refusée sans modification", async () => {
    const { client, appels } = faux({ instance: false });
    await expect(activerInstance(client, A, I)).rejects.toMatchObject({ code: "regle_metier", motif: "instance_introuvable" });
    expect(appels.some((a) => a.texte.startsWith("UPDATE"))).toBe(false);
  });
});

describe("activer une instance : fait C3", () => {
  const enregistreur = () => {
    const faits: { i: { id: string; occurredAt: string }; t: string; code: string; date: string }[] = [];
    const emetteur = { automatisationActivee: async (i: { id: string; occurredAt: string }, t: string, code: string, date: string) => void faits.push({ i, t, code, date }) };
    return { faits, emetteur };
  };

  it("[C-346] automatisation.activee part dans la transaction de l'activation, jamais pour une activation refusée", async () => {
    const { faits, emetteur } = enregistreur();
    const { client } = faux({ contrat: false });
    await activerInstance(client, A, I, emetteur as never).catch(() => undefined);
    expect(faits).toEqual([]);
  });

  it("[C-346] le fait porte le client, le code de l'automatisation, la clé d'intention du jour et la date prise en base (Europe/Paris)", async () => {
    const { faits, emetteur } = enregistreur();
    const { client, appels } = faux({ contrat: true, jour: "2026-11-03" });
    await activerInstance(client, A, I, emetteur as never);
    expect(faits).toEqual([{ i: { id: `activation:${I}:2026-11-03`, occurredAt: "2026-11-03T00:00:00Z" }, t: A, code: "tri-courriels", date: "2026-11-03" }]);
    const maj = appels.find((a) => a.texte.startsWith("UPDATE"));
    expect(maj?.texte).toMatch(/etat <> 'active'/);
    expect(maj?.texte).toMatch(/Europe\/Paris/);
    expect(maj?.texte).toMatch(/RETURNING/);
  });

  it("[C-346] instance déjà active : aucune écriture en plus, aucun fait, pas d'erreur", async () => {
    const { faits, emetteur } = enregistreur();
    const { client } = faux({ contrat: true, dejaActive: true });
    await expect(activerInstance(client, A, I, emetteur as never)).resolves.toBeUndefined();
    expect(faits).toEqual([]);
  });

  it("[C-346] @anti-doublon une activation rejouée un autre jour ne fait pas échouer la transaction (boîte d'envoi : même intention, autre corps refusée)", async () => {
    const deposees = new Map<string, string>();
    const emetteur = emetteurC3({
      tenantId: A, idTrace: "trace-0001",
      deposer: async (d) => {
        const avant = deposees.get(d.intention);
        const corps = JSON.stringify(d.corps);
        if (avant !== undefined && avant !== corps) throw new Error("intention déjà déposée avec un autre corps");
        deposees.set(d.intention, corps);
        return { nouveau: avant === undefined };
      },
    });
    // Première activation (lundi), puis l'instance est mise en pause et réactivée le lendemain.
    await activerInstance(faux({ contrat: true, jour: "2026-11-02" }).client, A, I, emetteur);
    await expect(activerInstance(faux({ contrat: true, jour: "2026-11-03" }).client, A, I, emetteur)).resolves.toBeUndefined();
    expect(deposees.size).toBe(2);
  });

  it("[C-346] si le dépôt du fait échoue, l'activation échoue (la transaction de l'appelant est annulée)", async () => {
    const emetteur = { automatisationActivee: async () => { throw new Error("dépôt impossible"); } };
    const { client } = faux({ contrat: true });
    await expect(activerInstance(client, A, I, emetteur as never)).rejects.toThrow("dépôt impossible");
  });
});
