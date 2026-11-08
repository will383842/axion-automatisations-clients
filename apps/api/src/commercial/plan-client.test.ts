import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Requeteur } from "../instances/activer.ts";
import { lirePlanClient, statutPhase } from "./plan-client.ts";

// Requêtes du dépôt de lecture du plan, sans base : un faux client enregistre le texte et les valeurs. Montants FICTIFS.
type Appel = { texte: string; valeurs: unknown[] };
const T = randomUUID();
function fauxClient(conditions: Record<string, unknown>[] = []) {
  const appels: Appel[] = [];
  const planId = randomUUID();
  const client: Requeteur = {
    async query(texte, valeurs = []) {
      appels.push({ texte, valeurs });
      const rows = (r: Record<string, unknown>[]) => ({ rows: r, rowCount: r.length });
      if (texte.includes("FROM instances")) return rows([{ instance_id: randomUUID(), code_automatisation: "relance-devis", etat: "active", formule: "abonnement", plan_id: planId, plan_auteur: "agent-essai", enregistre_le: "2026-11-02T08:30:00.000Z",
        frais_mise_en_place_ht_centimes: "5000", prix_recurrent_mensuel_ht_centimes: "1000", periode_facturation_mois: 1, mode_avance: "aucune", maintenance_incluse_mois: 3, suite_maintenance: "arret", engagement_mois: 12,
        source_formule: "instance", source_frais_mise_en_place: "grille", source_prix_recurrent_mensuel: "grille", source_periode_facturation: "defaut", source_mode_avance: "defaut", source_maintenance_incluse: "grille", source_suite_maintenance: "defaut", source_engagement: "defaut" }]);
      if (texte.includes("FROM phases_plan")) return rows([]);
      if (texte.includes("FROM conditions_commerciales")) return rows(conditions);
      return rows([]);
    },
  };
  return { client, appels };
}

describe("dépôt de lecture du plan", () => {
  it("[A-040] le dernier changement d'une condition donne son auteur et sa date, lus au journal", async () => {
    const { client, appels } = fauxClient([{ id: randomUUID(), type: "frais", valeur: { frais_mise_en_place_centimes: 4000 }, valide_du: null, valide_au: null, auteur: "agent-essai", modifie_le: "2026-10-30T09:00:00.000Z" }]);
    const lu = await lirePlanClient(client, T, "2026-11-07");
    expect(lu.conditions[0]).toMatchObject({ auteur: "agent-essai", modifieLe: "2026-10-30T09:00:00.000Z" });
    const texte = appels.find((a) => a.texte.includes("FROM conditions_commerciales"))?.texte ?? "";
    expect(texte).toContain("entite = 'conditions_commerciales'");
    expect(texte).toMatch(/ORDER BY[^)]*DESC\s+LIMIT 1/);
    expect(texte).toContain("journal_audit");
  });

  it("[C-183] une condition du client égale à la valeur par défaut reste personnalisée", async () => {
    // Le dépôt ne lit aucune valeur par défaut et ne compare rien : la présence d'une condition du client suffit.
    const { client, appels } = fauxClient([{ id: randomUUID(), type: "engagement", valeur: { engagement_mois: 12 }, valide_du: null, valide_au: null, auteur: "agent-essai", modifie_le: "2026-10-30T09:00:00.000Z" }]);
    const lu = await lirePlanClient(client, T, "2026-11-07");
    expect(lu.conditions).toHaveLength(1);
    expect(appels.some((a) => /conditions_par_defaut|grilles_prix|prereglages_metier/.test(a.texte))).toBe(false);
    expect(readFileSync(new URL("./plan-client.ts", import.meta.url), "utf8")).not.toMatch(/conditions_par_defaut|calculerPlan|preparerPlan/);
  });

  it("[LOT3-argent] chaque requête nomme tenant_id en plus de la RLS et aucune ne fait SELECT *", async () => {
    const { client, appels } = fauxClient([]);
    await lirePlanClient(client, T, "2026-11-07");
    expect(appels.length).toBeGreaterThanOrEqual(3);
    for (const a of appels) {
      expect(a.texte, a.texte).toMatch(/tenant_id = \$1/);
      expect(a.texte, a.texte).not.toMatch(/SELECT\s+\*|\.\*|\bDELETE\b|\bUPDATE\b|\bINSERT\b/i);
      expect(a.valeurs[0]).toBe(T);
    }
    const conditions = appels.find((a) => a.texte.includes("FROM conditions_commerciales"));
    expect(conditions?.valeurs[1]).toBe("2026-11-07");
  });

  it("[B-037] le statut d'une phase vient des dates, au jour de Paris", () => {
    // Fin INCLUSE : la phase qui finit aujourd'hui est encore en cours.
    expect(statutPhase("2026-11-08", "2026-12-08", "2026-11-07")).toBe("a_venir");
    expect(statutPhase("2026-11-07", "2026-12-08", "2026-11-07")).toBe("en_cours");
    expect(statutPhase("2026-10-01", "2026-11-07", "2026-11-07")).toBe("en_cours");
    expect(statutPhase("2026-10-01", "2026-11-06", "2026-11-07")).toBe("terminee");
    expect(statutPhase("2026-10-01", null, "2026-11-07")).toBe("en_cours");
    expect(statutPhase("2026-11-08", null, "2026-11-07")).toBe("a_venir");
  });
});
