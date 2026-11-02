import { describe, expect, it } from "vitest";
import { activerInstance, ErreurRegleMetier, MOTIF_SOUS_TRAITANCE_ABSENTE, type Requeteur } from "./activer.ts";

// Faux client : répond selon la requête ; la base reste la garantie (déclencheur de la migration 0009, essais dans db/contrats.int.test.ts).
const A = "11111111-1111-4111-8111-111111111111";
const I = "22222222-2222-4222-8222-222222222222";
function faux(opts: { instance?: boolean; contrat?: boolean; refusBase?: boolean; majVide?: boolean }) {
  const appels: { texte: string; valeurs: unknown[] }[] = [];
  const client: Requeteur = {
    async query(texte, valeurs = []) {
      appels.push({ texte, valeurs });
      if (texte.includes("FROM instances")) return { rows: opts.instance === false ? [] : [{ organisation_id: A }], rowCount: opts.instance === false ? 0 : 1 };
      if (texte.includes("FROM contrats")) return { rows: opts.contrat ? [{ un: 1 }] : [], rowCount: opts.contrat ? 1 : 0 };
      if (opts.refusBase) throw Object.assign(new Error("regle_metier"), { code: "P0001", detail: MOTIF_SOUS_TRAITANCE_ABSENTE });
      return { rows: [], rowCount: opts.majVide ? 0 : 1 };
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
