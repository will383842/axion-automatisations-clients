import { afterEach, describe, expect, it, vi } from "vitest";
import type { Requeteur } from "../instances/activer.ts";
import { dateParis } from "./lire-niveaux.ts";
import { preparerPlan } from "./plan.ts";

// Requêtes que preparerPlan envoie, sans base : un faux client enregistre le texte et les valeurs. Montants FICTIFS.
type Appel = { texte: string; valeurs: unknown[] };
function fauxClient(formulesActives: unknown = ["abonnement", "achat", "installation_maintenance"], formule = "abonnement") {
  const appels: Appel[] = [];
  const client: Requeteur = {
    async query(texte, valeurs = []) {
      appels.push({ texte, valeurs });
      const rows = (r: Record<string, unknown>[]) => ({ rows: r, rowCount: r.length });
      if (texte.includes("FROM instances")) return rows([{ organisation_id: "org-1", automatisation_id: "auto-1", formule }]);
      if (texte.includes("FROM grilles_prix")) return rows([{ montant_installation_centimes: "5000", montant_mensuel_centimes: "1000", maintenance_incluse_mois: 3, formules_actives: formulesActives }]);
      if (texte.includes("FROM prereglages_metier")) return rows([{ donnees: { engagement_mois: 24 }, version: 2 }]);
      if (texte.includes("FROM conditions_par_defaut")) return rows([{ type: "engagement", valeur: { engagement_mois: 12, suite_maintenance: "arret" } }, { type: "periode", valeur: { periode_facturation_mois: 1, mode_avance: "aucune" } }]);
      return rows([]);
    },
  };
  return { client, appels };
}
afterEach(() => vi.useRealTimers());

describe("requêtes du plan commercial", () => {
  it("[C-138] @argent la formule de l'instance est comparée aux formules actives de la grille, lues dans la même requête", async () => {
    const { client, appels } = fauxClient(["abonnement"], "achat");
    await expect(preparerPlan(client, "t", "i", { date: "2026-07-01" })).rejects.toMatchObject({ motif: "formule_non_proposee" });
    expect(appels.filter((a) => a.texte.includes("FROM grilles_prix"))).toHaveLength(1);
    expect(appels.find((a) => a.texte.includes("FROM grilles_prix"))?.texte).toContain("formules_actives");
  });

  it("[C-138] @argent une grille sans liste lisible de formules est refusée, jamais prise pour « toutes »", async () => {
    for (const mauvaise of [null, "abonnement", [1]]) {
      await expect(preparerPlan(fauxClient(mauvaise).client, "t", "i", { date: "2026-07-01" }), JSON.stringify(mauvaise)).rejects.toMatchObject({ motif: "valeur_invalide:formules_actives" });
    }
  });

  it("[C-676] le préréglage du métier est la version de départ demandée, jamais la dernière publiée ; sans version, refus", async () => {
    const sans = fauxClient();
    await expect(preparerPlan(sans.client, "t", "i", { metierId: "m-1", date: "2026-07-01" })).rejects.toMatchObject({ motif: "version_metier_obligatoire" });
    expect(sans.appels.some((a) => a.texte.includes("FROM prereglages_metier"))).toBe(false);
    const avec = fauxClient();
    const plan = await preparerPlan(avec.client, "t", "i", { metierId: "m-1", versionMetier: 2, date: "2026-07-01" });
    const requete = avec.appels.find((a) => a.texte.includes("FROM prereglages_metier"));
    expect(requete?.texte).not.toMatch(/ORDER BY version DESC/);
    expect(requete?.texte).toMatch(/version = \$3/);
    expect(requete?.valeurs).toContain(2);
    expect(plan.valeurs["engagement_mois"]).toMatchObject({ valeur: 24, source: "metier", version: 2 });
  });

  it("[C-138] la date du jour est celle d'Europe/Paris, et la fin de validité est exclue (jour de passation)", async () => {
    expect(dateParis(new Date("2026-06-30T22:30:00Z"))).toBe("2026-07-01");
    expect(dateParis(new Date("2026-01-15T23:30:00Z"))).toBe("2026-01-16");
    expect(dateParis(new Date("2026-01-15T22:30:00Z"))).toBe("2026-01-15");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-30T22:30:00Z"));
    const { client, appels } = fauxClient();
    await preparerPlan(client, "t", "i", {});
    for (const a of appels.filter((x) => x.texte.includes("FROM conditions_"))) {
      expect(a.valeurs).toContain("2026-07-01");
      expect(a.texte).toContain("valide_au > $2::date");
      expect(a.texte).not.toContain("valide_au >= $2::date");
    }
    expect(appels.filter((x) => x.texte.includes("FROM conditions_"))).toHaveLength(2);
  });
});
