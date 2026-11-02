import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { cleDIntention } from "../../../../packages/contrats/src/commun/idempotence.js";
import { deposer, transactionOuverte, type TransactionOuverte } from "./boite-envoi.js";

// Fausse transaction : enregistre les requêtes, répond « client fixé » comme avecClient (app.tenant_id), ou rien (hors transaction).
const TENANT = randomUUID();
function fausseTx(tenant: string | null = TENANT) {
  const requetes: { sql: string; params: unknown[] }[] = [];
  const client = {
    async query(sql: string, params: unknown[] = []) {
      requetes.push({ sql, params });
      if (/current_setting/.test(sql)) return { rows: [{ tenant }] };
      if (/INSERT INTO boite_envoi/.test(sql)) return { rows: [{ id: randomUUID(), cle_anti_doublon: params[5], empreinte_corps: params[7] }] };
      return { rows: [] };
    },
  };
  return { requetes, tx: transactionOuverte(client as never) as TransactionOuverte };
}
const RETROUVER = "/api/console/v1/clients/retrouver-ou-creer";
const corps = { consoleClientId: "console-cli-0001", raisonSociale: "Atelier Bertin", adresse: { ligne1: "1 rue d'essai", codePostal: "75001", ville: "Ville-Test", pays: "FR" }, contactFacturation: { nom: "Camille Test", email: "contact@exemple.fr" } };
const depot = (surcharge: object = {}) => ({ destination: "hub" as const, route: RETROUVER, methode: "POST" as const, corps, intention: "retrouver:console-cli-0001", ...surcharge });

describe("dépôt dans la boîte d'envoi", () => {
  it("[C-402] @anti-doublon la ligne est écrite par la transaction métier reçue, jamais par une autre connexion", async () => {
    const { tx, requetes } = fausseTx();
    await deposer(tx, depot());
    expect(requetes.some((r) => /INSERT INTO boite_envoi/.test(r.sql))).toBe(true);
    expect(requetes.some((r) => /pg_notify/.test(r.sql))).toBe(true);
  });

  it("[C-402] @anti-doublon sans transaction ouverte (aucun client fixé), le dépôt est refusé", async () => {
    const { tx, requetes } = fausseTx(null);
    await expect(deposer(tx, depot())).rejects.toThrow(/transaction/);
    expect(requetes.some((r) => /INSERT/.test(r.sql))).toBe(false);
  });

  it("[C-535] @anti-doublon la clé vient de la fonction du contrat, dérivée de la destination et de l'intention", async () => {
    const { tx, requetes } = fausseTx();
    const r = await deposer(tx, depot());
    expect(r.cle).toBe(cleDIntention("hub", "retrouver:console-cli-0001"));
    expect(requetes.find((q) => /INSERT/.test(q.sql))?.params).toContain(r.cle);
    expect(r.cle).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("[C-402] le corps est limité au schéma de la route : un champ hors contrat est refusé", async () => {
    const { tx } = fausseTx();
    await expect(deposer(tx, depot({ corps: { ...corps, notesDeTravailDuClient: "texte" } }))).rejects.toThrow(/hors contrat/);
    await expect(deposer(tx, depot({ route: "/api/console/v1/inconnue" }))).rejects.toThrow(/route/);
    await expect(deposer(tx, depot({ destination: "crm" }))).rejects.toThrow(/route/);
  });
});
