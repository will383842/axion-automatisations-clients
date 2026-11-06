import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { cleEvenementContratSigne, declencherProvisionnement, deposerProvisionnement, type FileProvisionnement, surContratSigne, type EvenementContratSigne, type Transaction } from "./declencher.js";

const ORG = randomUUID();
const evenement = (organisation = ORG): EvenementContratSigne => ({ type: "contrat_signe", organisation, devis: "devis-001", emisLe: "2026-11-02T10:00:00.000Z" });
function monter(dejaActive = false) {
  const journal: string[] = [];
  const tx: Transaction = { query: async (texte: string, valeurs: unknown[]) => { journal.push(`sql:${texte.split(" ").slice(0, 3).join(" ")}`); return { rows: dejaActive ? [] : [{ nom_base: valeurs[2] }] }; } };
  return {
    journal,
    deps: {
      enTransaction: async <T,>(_t: string, fn: (tx: Transaction) => Promise<T>) => { journal.push("debut"); const r = await fn(tx); journal.push("validation"); return r; },
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

  it("[A-224] reprise manuelle : une tâche restée dans l'ensemble failed est retirée puis redéposée, un nouvel add n'est plus ignoré en silence", async () => {
    const ajouts: { nom: string; donnees: unknown; options: Record<string, unknown> }[] = [];
    const retires: string[] = [];
    let etat: string | undefined = "failed";
    const file: FileProvisionnement = {
      getJob: async (id) => (etat === undefined ? undefined : { getState: async () => etat!, remove: async () => { retires.push(id); etat = undefined; } }),
      add: async (nom, donnees, options) => void ajouts.push({ nom, donnees, options }),
    };
    await deposerProvisionnement(file, ORG);
    expect(retires).toEqual([`provision-${ORG}`]);
    expect(ajouts).toHaveLength(1);
    expect(ajouts[0]!.donnees).toEqual({ tenantId: ORG });
    expect(ajouts[0]!.options).toMatchObject({ jobId: `provision-${ORG}`, attempts: 5 });
  });

  it("[C-498] @anti-doublon une tâche en attente, active ou différée n'est ni retirée ni doublée ; en majuscules, même identifiant", async () => {
    for (const etat of ["waiting", "active", "delayed"]) {
      const ajouts: unknown[] = [];
      const retires: string[] = [];
      const file: FileProvisionnement = { getJob: async () => ({ getState: async () => etat, remove: async () => void retires.push(etat) }), add: async (...a) => void ajouts.push(a) };
      await deposerProvisionnement(file, ORG.toUpperCase());
      expect([ajouts, retires]).toEqual([[], []]);
    }
  });
});
