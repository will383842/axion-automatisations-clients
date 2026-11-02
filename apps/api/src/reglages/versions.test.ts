import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { ErreurApi } from "../plugins/erreurs.js";
import { historique, modifier, revenir, serviceAnnulationReglages } from "./versions.js";

// Versions des réglages (A-175, A-176) : base simulée en mémoire ; la concurrence réelle est vérifiée par versions.int.test.ts.
const TENANT = "11111111-1111-4111-8111-111111111111";
const INSTANCE = "22222222-2222-4222-8222-222222222222";
const SCHEMA = { type: "object", properties: { relance_jours: { type: "integer", minimum: 1 }, ton: { type: "string" } }, required: ["relance_jours"], additionalProperties: false };

type Ligne = { id: string; numero: number; donnees: Record<string, unknown>; auteur: string; motif_changement: string; active: boolean; active_par: string | null };
function base() {
  const lignes: Ligne[] = [];
  const requetes: string[] = [];
  let tenant = "";
  const client = {
    release() {},
    async query(sql: string, p: unknown[] = []) {
      requetes.push(sql);
      if (/set_config\('app\.tenant_id'/.test(sql)) tenant = String(p[0]);
      if (/FROM instances/.test(sql)) return { rows: tenant === TENANT && p[0] === INSTANCE ? [{ schema_configuration: SCHEMA, semver: "1.2.0" }] : [] };
      if (/max\(numero\)/.test(sql)) return { rows: [{ dernier: Math.max(0, ...lignes.map((l) => l.numero)) }] };
      if (/UPDATE configurations SET active = false/.test(sql)) { for (const l of lignes) if (l.active) { l.active = false; l.active_par = String(p[1]); } return { rows: [] }; }
      if (/INSERT INTO configurations/.test(sql)) { lignes.push({ id: String(p[0]), numero: Number(p[2]), donnees: JSON.parse(String(p[3])) as Record<string, unknown>, auteur: String(p[5]), motif_changement: String(p[6]), active: false, active_par: null }); return { rows: [] }; }
      if (/UPDATE configurations SET active = true/.test(sql)) { const l = lignes.find((x) => x.id === p[0])!; l.active = true; l.active_par = String(p[1]); return { rows: [] }; }
      if (/FROM configurations WHERE instance_id = \$1 AND numero = \$2/.test(sql)) return { rows: lignes.filter((l) => l.numero === p[1]) };
      if (/numero FROM configurations WHERE instance_id = \$1 AND active/.test(sql)) return { rows: lignes.filter((l) => l.active) };
      if (/FROM configurations/.test(sql)) return { rows: [...lignes].sort((a, b) => b.numero - a.numero) };
      return { rows: [] };
    },
  };
  const pool = { connect: async () => client } as unknown as Pool;
  return { pool, lignes, requetes };
}
const ecrire = (b: ReturnType<typeof base>, n: number) => modifier(b.pool, TENANT, INSTANCE, { relance_jours: n }, "agent-essai", `réglage ${n}`);

describe("versions des réglages", () => {
  it("[A-175] une modification crée une version et une seule reste active", async () => {
    const b = base();
    await ecrire(b, 3); await ecrire(b, 5);
    expect(b.lignes.map((l) => l.numero)).toEqual([1, 2]);
    expect(b.lignes.filter((l) => l.active).map((l) => l.numero)).toEqual([2]);
    expect(b.lignes[0]?.donnees).toEqual({ relance_jours: 3 });
  });

  it("[A-175] l'instance est verrouillée (FOR UPDATE) avant la lecture du dernier numéro", async () => {
    const b = base();
    await ecrire(b, 3);
    const verrou = b.requetes.findIndex((s) => /FOR UPDATE/.test(s));
    expect(verrou).toBeGreaterThan(-1);
    expect(b.requetes.findIndex((s) => /max\(numero\)/.test(s))).toBeGreaterThan(verrou);
  });

  it("[A-175] des données qui ne respectent pas le schéma de configuration sont refusées", async () => {
    const b = base();
    for (const donnees of [{ relance_jours: 0 }, { ton: "x" }, { relance_jours: 2, inconnu: 1 }, [] as never]) {
      await expect(modifier(b.pool, TENANT, INSTANCE, donnees, "agent-essai", "essai")).rejects.toMatchObject({ code: "schema_invalide" });
    }
    expect(b.lignes).toEqual([]);
  });

  it("[A-176] revenir à la version 2 crée la version 5 identique à la 2 ; les versions 1 à 4 restent", async () => {
    const b = base();
    for (const n of [1, 2, 3, 4]) await ecrire(b, n);
    const avant = structuredClone(b.lignes.map((l) => ({ numero: l.numero, donnees: l.donnees })));
    const v = await revenir(b.pool, TENANT, INSTANCE, 2, "agent-essai");
    expect(v.numero).toBe(5);
    expect(b.lignes[4]).toMatchObject({ numero: 5, donnees: { relance_jours: 2 }, active: true, motif_changement: "retour à la version 2" });
    expect(b.lignes.slice(0, 4).map((l) => ({ numero: l.numero, donnees: l.donnees }))).toEqual(avant);
    expect(b.lignes.filter((l) => l.active)).toHaveLength(1);
  });

  it("[A-176] revenir à une version qui n'existe pas répond introuvable", async () => {
    const b = base();
    await ecrire(b, 1);
    await expect(revenir(b.pool, TENANT, INSTANCE, 9, "agent-essai")).rejects.toMatchObject({ code: "introuvable" });
  });

  it("[A-175] l'historique liste toutes les versions, la plus récente d'abord", async () => {
    const b = base();
    await ecrire(b, 1); await ecrire(b, 2);
    expect((await historique(b.pool, TENANT, INSTANCE)).map((v) => v.numero)).toEqual([2, 1]);
  });

  it("[A-119] @isolation l'instance d'un autre client répond introuvable", async () => {
    const b = base();
    const AUTRE = "33333333-3333-4333-8333-333333333333";
    const e = await modifier(b.pool, AUTRE, INSTANCE, { relance_jours: 2 }, "agent-essai", "essai").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ErreurApi);
    expect(e).toMatchObject({ code: "introuvable" });
    await expect(historique(b.pool, AUTRE, INSTANCE)).rejects.toMatchObject({ code: "introuvable" });
    expect(b.lignes).toEqual([]);
  });

  it("[C-443] l'annulation d'une modification recrée la version précédente (rien n'est supprimé)", async () => {
    const b = base();
    await ecrire(b, 1); await ecrire(b, 2);
    const client = await (b.pool as unknown as { connect(): Promise<never> }).connect();
    const nouvelle = JSON.stringify({ instance_id: INSTANCE, numero: 2 });
    await serviceAnnulationReglages.annuler(client, { id: "7", tenant_id: TENANT, entite: "configurations", entite_id: "x", action: "insertion", ancienne: null, nouvelle }, "agent-essai");
    expect(b.lignes.map((l) => l.numero)).toEqual([1, 2, 3]);
    expect(b.lignes[2]).toMatchObject({ donnees: { relance_jours: 1 }, active: true, motif_changement: "annulation de la version 2" });
  });
});
