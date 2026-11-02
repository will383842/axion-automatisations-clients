import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { cleEvenementContratSigne, declencherProvisionnement, surContratSigne, type EvenementContratSigne } from "./declencher.js";

const ORG = randomUUID();
const evenement = (organisation = ORG): EvenementContratSigne => ({ type: "contrat_signe", organisation, devis: "devis-001", emisLe: "2026-11-02T10:00:00.000Z" });
function monter(dejaActive = false) {
  const journal: string[] = [];
  const tx = { query: async (texte: string, valeurs: unknown[]) => { journal.push(`sql:${texte.split(" ").slice(0, 3).join(" ")}`); return { rows: dejaActive ? [] : [{ nom_base: valeurs[2] }] }; } };
  return {
    journal,
    deps: {
      enTransaction: async <T,>(_t: string, fn: (tx: typeof tx) => Promise<T>) => { journal.push("debut"); const r = await fn(tx); journal.push("validation"); return r; },
      passerAuStatutClient: async () => { journal.push("statut"); },
      deposer: async (t: string) => { journal.push(`depot:${t}`); },
    },
  };
}

describe("déclenchement du provisionnement", () => {
  it("[C-498] un événement contrat_signe factice déclenche la création de la base, dans la transaction du passage à client, dépôt APRÈS validation", async () => {
    const m = monter();
    await surContratSigne(evenement(), m.deps);
    expect(m.journal).toEqual(["debut", "statut", "sql:INSERT INTO bases_client", "validation", `depot:${ORG}`]);
  });

  it("[C-498] la clé d'intention est contrat_signe:<organisation>:<devis>", () => {
    expect(cleEvenementContratSigne(evenement())).toBe(`contrat_signe:${ORG}:devis-001`);
  });

  it("[C-498] @anti-doublon un second événement pour une base déjà présente ne dépose aucune tâche", async () => {
    const m = monter(true);
    await surContratSigne(evenement(), m.deps);
    expect(m.journal.some((l) => l.startsWith("depot:"))).toBe(false);
  });

  it("[C-498] @isolation un événement mal formé ou une organisation piégée est refusé avant toute écriture", async () => {
    const m = monter();
    await expect(surContratSigne({ ...evenement(), organisation: "x'; DROP TABLE bases_client;--" }, m.deps)).rejects.toThrow();
    await expect(surContratSigne({ ...evenement(), type: "autre" } as never, m.deps)).rejects.toThrow();
    expect(m.journal).toEqual([]);
  });

  it("[C-498] declencherProvisionnement écrit la ligne en_creation sans écraser une ligne existante (ON CONFLICT DO NOTHING)", async () => {
    const textes: string[] = [];
    const r = await declencherProvisionnement({ query: async (t) => { textes.push(t); return { rows: [] }; } }, ORG);
    expect(r).toEqual({ cree: false });
    expect(textes[0]).toMatch(/ON CONFLICT .* DO NOTHING/s);
  });
});
