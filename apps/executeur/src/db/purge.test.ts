import { describe, expect, it } from "vitest";
import { DELAI_ERREUR_MS, DELAI_REUSSITE_MS, estPurgeable, purger } from "./purge.ts";

// Règle de purge de l'état technique (C-021) : réussite après 24 h, erreur après 7 jours, jamais sous gel, jamais sans réponse du gel.
const MAINTENANT = new Date("2026-11-01T12:00:00Z");
const il_y_a = (ms: number) => new Date(MAINTENANT.getTime() - ms);
const H = 3_600_000;
const J = 24 * H;
const INSTANCE = "33333333-3333-4333-8333-333333333333";
const exec = (issue: "reussite" | "erreur", age: number, instanceId = INSTANCE) => ({ issue, fin: il_y_a(age), instanceId });

describe("purge de l'état technique", () => {
  it("[C-021] une réussite de 25 h est purgée, une de 23 h reste ; une erreur de 6 jours reste, de 8 jours est purgée", () => {
    expect(DELAI_REUSSITE_MS).toBe(24 * H);
    expect(DELAI_ERREUR_MS).toBe(7 * J);
    const vide = new Set<string>();
    expect(estPurgeable(exec("reussite", 25 * H), MAINTENANT, vide)).toBe(true);
    expect(estPurgeable(exec("reussite", 23 * H), MAINTENANT, vide)).toBe(false);
    expect(estPurgeable(exec("erreur", 6 * J), MAINTENANT, vide)).toBe(false);
    expect(estPurgeable(exec("erreur", 8 * J), MAINTENANT, vide)).toBe(true);
    expect(estPurgeable({ issue: "reussite", fin: null, instanceId: INSTANCE }, MAINTENANT, vide)).toBe(false);
  });

  it("[C-021] une instance sous gel n'est pas purgée", () => {
    expect(estPurgeable(exec("reussite", 30 * H), MAINTENANT, new Set([INSTANCE]))).toBe(false);
    expect(estPurgeable(exec("erreur", 30 * J), MAINTENANT, new Set([INSTANCE]))).toBe(false);
  });

  it("[C-021] gel illisible → la purge ne supprime rien (ni sans lecture du gel, ni quand elle échoue)", async () => {
    const requetes: string[] = [];
    const pool = { connect: async () => ({ query: async (s: string) => (requetes.push(s), { rows: [], rowCount: 0 }), release: () => undefined }) };
    const sansLecture = await purger(pool as never, { maintenant: MAINTENANT });
    expect(sansLecture).toEqual({ purgees: 0, arret: "gel_illisible" });
    const enPanne = await purger(pool as never, { maintenant: MAINTENANT, lireGel: async () => { throw new Error("console injoignable"); } });
    expect(enPanne).toEqual({ purgees: 0, arret: "gel_illisible" });
    expect(requetes.filter((s) => /DELETE/i.test(s))).toEqual([]);
  });
});
