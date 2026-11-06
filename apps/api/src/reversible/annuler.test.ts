import { describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { annuler, ENTITES_ANNULABLES, type LigneAnnulation, type ServicesAnnulation } from "./annuler.js";
import { modifierDans, serviceAnnulationReglages } from "../reglages/versions.js";

// Annulation en un clic (A-030, C-443) : liste fermée d'entités, chaque retour passe par le service du domaine.
// La base simulée ne filtre PAS par client toute seule : elle suit le set_config reçu, comme le fait la politique RLS.
const TENANT = "11111111-1111-4111-8111-111111111111";
const AUTRE = "99999999-9999-4999-8999-999999999999";
const INSTANCE = "22222222-2222-4222-8222-222222222222";
const SCHEMA = { type: "object", properties: { relance_jours: { type: "integer", minimum: 1 } }, required: ["relance_jours"], additionalProperties: false };
type Config = { id: string; numero: number; donnees: Record<string, unknown>; active: boolean };
function monde(lignes: LigneAnnulation[]) {
  const appels: string[] = [];
  const requetes: string[] = [];
  const journal: LigneAnnulation[] = [...lignes];
  const configs: Config[] = [];
  let tenant = "";
  const ajouterJournal = (action: string, nouvelle: object) => journal.push({ id: String(100 + journal.length), tenant_id: tenant, entite: "configurations", entite_id: null, action, ancienne: null, nouvelle: JSON.stringify(nouvelle) });
  const client = {
    release() {},
    async query(sql: string, p: unknown[] = []) {
      requetes.push(sql);
      if (/set_config\('app\.tenant_id'/.test(sql)) tenant = String(p[0]);
      if (/FROM public\.journal_audit/.test(sql)) return { rows: journal.filter((l) => l.id === p[0] && l.tenant_id === tenant) };
      if (/FROM instances/.test(sql)) return { rows: tenant === TENANT && p[0] === INSTANCE ? [{ schema_configuration: SCHEMA, semver: "1.0.0" }] : [] };
      if (/max\(numero\)/.test(sql)) return { rows: [{ dernier: Math.max(0, ...configs.map((c) => c.numero)) }] };
      if (/UPDATE configurations SET active = false/.test(sql)) { for (const c of configs) c.active = false; return { rows: [] }; }
      if (/INSERT INTO configurations/.test(sql)) { configs.push({ id: String(p[0]), numero: Number(p[2]), donnees: JSON.parse(String(p[3])) as Record<string, unknown>, active: false }); ajouterJournal("insertion", { instance_id: p[1], numero: Number(p[2]) }); return { rows: [] }; }
      if (/UPDATE configurations SET active = true/.test(sql)) { configs.find((c) => c.id === p[0])!.active = true; ajouterJournal("modification", { active: true }); return { rows: [] }; }
      if (/AND numero = \$2/.test(sql)) return { rows: configs.filter((c) => c.numero === p[1]) };
      if (/FROM configurations WHERE instance_id = \$1 AND active/.test(sql)) return { rows: configs.filter((c) => c.active) };
      return { rows: [] };
    },
  };
  const pool = { connect: async () => client } as unknown as Pool;
  const service = (nom: string) => ({ async annuler(_c: unknown, l: LigneAnnulation, auteur: string) { appels.push(`${nom}:${l.entite_id}:${auteur}`); return { entite: l.entite, entite_id: l.entite_id ?? "" }; } });
  const services = { configurations: service("reglage"), plans_commerciaux: service("plan"), conditions_commerciales: service("conditions") } as unknown as ServicesAnnulation;
  return { pool, client: client as unknown as PoolClient, services, appels, requetes, journal, configs, definirClient: (t: string) => { tenant = t; } };
}
const ligne = (id: string, entite: string, tenant: string | null = TENANT): LigneAnnulation => ({ id, tenant_id: tenant, entite, entite_id: "e1", action: "modification", ancienne: '{"v":1}', nouvelle: '{"v":2}' });

describe("annulation d'un changement", () => {
  it("[C-443] une modification de réglage apparaît au journal et s'annule en un clic (vrai service des réglages)", async () => {
    const m = monde([]);
    m.definirClient(TENANT);
    await modifierDans(m.client, INSTANCE, { relance_jours: 1 }, "agent-essai", "premier");
    await modifierDans(m.client, INSTANCE, { relance_jours: 2 }, "agent-essai", "second");
    const insertion = m.journal.filter((l) => l.action === "insertion").at(-1)!;
    expect(JSON.parse(insertion.nouvelle!)).toEqual({ instance_id: INSTANCE, numero: 2 });
    const r = await annuler({ pool: m.pool, services: { configurations: serviceAnnulationReglages } }, TENANT, "agent-essai", insertion.id);
    expect(r.entite).toBe("configurations");
    expect(m.configs.map((c) => c.numero)).toEqual([1, 2, 3]);
    expect(m.configs.find((c) => c.active)).toMatchObject({ numero: 3, donnees: { relance_jours: 1 } });
    // L'annulation est elle-même un changement lu au journal : une nouvelle insertion, numéro 3.
    expect(JSON.parse(m.journal.filter((l) => l.action === "insertion").at(-1)!.nouvelle!)).toEqual({ instance_id: INSTANCE, numero: 3 });
    // La même ligne ne s'annule pas deux fois.
    await expect(annuler({ pool: m.pool, services: { configurations: serviceAnnulationReglages } }, TENANT, "agent-essai", insertion.id)).rejects.toMatchObject({ code: "regle_metier" });
    expect(m.configs).toHaveLength(3);
  });

  it("[C-443] le vrai service refuse une ligne de modification (action_interdite)", async () => {
    const m = monde([ligne("10", "configurations")]);
    await expect(annuler({ pool: m.pool, services: { configurations: serviceAnnulationReglages } }, TENANT, "agent-essai", "10")).rejects.toMatchObject({ code: "action_interdite" });
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
    const m = monde([ligne("14", "configurations", AUTRE)]);
    await expect(annuler({ pool: m.pool, services: m.services }, TENANT, "agent-essai", "14")).rejects.toMatchObject({ code: "introuvable" });
    expect(m.appels).toEqual([]);
  });

  it("[A-119] @isolation la lecture du journal filtre explicitement par client, et le client actif posé est celui de la session", async () => {
    const m = monde([ligne("15", "plans_commerciaux", TENANT)]);
    await annuler({ pool: m.pool, services: m.services }, TENANT, "agent-essai", "15");
    expect(m.requetes.find((s) => /FROM public\.journal_audit/.test(s))).toMatch(/tenant_id = NULLIF\(current_setting\('app\.tenant_id', true\), ''\)::uuid/);
    // Le même numéro de ligne, demandé par un autre client, ne donne rien.
    await expect(annuler({ pool: m.pool, services: m.services }, AUTRE, "agent-essai", "15")).rejects.toMatchObject({ code: "introuvable" });
  });
});
