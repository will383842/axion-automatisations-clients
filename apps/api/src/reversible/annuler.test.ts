import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { annuler, ENTITES_ANNULABLES, type LigneAnnulation, type ServicesAnnulation } from "./annuler.js";

// Annulation en un clic (A-030, C-443) : liste fermée d'entités, chaque retour passe par le service du domaine.
const TENANT = "11111111-1111-4111-8111-111111111111";
function monde(lignes: LigneAnnulation[]) {
  const appels: string[] = [];
  const client = {
    release() {},
    async query(sql: string, p: unknown[] = []) {
      if (/FROM public\.journal_audit/.test(sql)) return { rows: lignes.filter((l) => l.id === p[0] && l.tenant_id === TENANT) };
      return { rows: [] };
    },
  };
  const pool = { connect: async () => client } as unknown as Pool;
  const service = (nom: string) => ({ async annuler(_c: unknown, l: LigneAnnulation, auteur: string) { appels.push(`${nom}:${l.entite_id}:${auteur}`); return { entite: l.entite, entite_id: l.entite_id ?? "" }; } });
  const services = { configurations: service("reglage"), plans_commerciaux: service("plan"), conditions_commerciales: service("conditions") } as unknown as ServicesAnnulation;
  return { pool, services, appels };
}
const ligne = (id: string, entite: string, tenant: string | null = TENANT): LigneAnnulation => ({ id, tenant_id: tenant, entite, entite_id: "e1", action: "modification", ancienne: '{"v":1}', nouvelle: '{"v":2}' });

describe("annulation d'un changement", () => {
  it("[C-443] une modification de réglage apparaît au journal et s'annule en un clic", async () => {
    const m = monde([ligne("10", "configurations")]);
    const r = await annuler({ pool: m.pool, services: m.services }, TENANT, "agent-essai", "10");
    expect(r).toEqual({ entite: "configurations", entite_id: "e1" });
    expect(m.appels).toEqual(["reglage:e1:agent-essai"]);
  });

  it("[A-030] un changement du plan commercial s'annule par la même route", async () => {
    const m = monde([ligne("11", "plans_commerciaux")]);
    await annuler({ pool: m.pool, services: m.services }, TENANT, "agent-essai", "11");
    expect(m.appels).toEqual(["plan:e1:agent-essai"]);
  });

  it("[A-030] une entité hors liste répond action_interdite", async () => {
    const m = monde([ligne("12", "journal_audit"), ligne("13", "factures")]);
    for (const id of ["12", "13"]) await expect(annuler({ pool: m.pool, services: m.services }, TENANT, "agent-essai", id)).rejects.toMatchObject({ code: "action_interdite" });
    expect(m.appels).toEqual([]);
    expect(ENTITES_ANNULABLES).toEqual(["configurations", "plans_commerciaux", "conditions_commerciales"]);
  });

  it("[A-119] @isolation la ligne d'un autre client répond introuvable", async () => {
    const m = monde([ligne("14", "configurations", "99999999-9999-4999-8999-999999999999")]);
    await expect(annuler({ pool: m.pool, services: m.services }, TENANT, "agent-essai", "14")).rejects.toMatchObject({ code: "introuvable" });
    expect(m.appels).toEqual([]);
  });
});
