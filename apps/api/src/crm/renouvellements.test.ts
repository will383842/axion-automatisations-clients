import { describe, expect, it } from "vitest";
import { signalerRenouvellementsProches } from "./renouvellements.ts";

const T = "11111111-1111-4111-8111-111111111111";
// Faux client : applique la plage donnée en paramètres ($2 exclu, $3 inclus) aux fins des abonnements fournis.
function banc(fins: (string | null)[]) {
  const requetes: { texte: string; valeurs: unknown[] }[] = [];
  const client = {
    query: async (texte: string, valeurs: unknown[] = []) => {
      requetes.push({ texte, valeurs });
      const [, apres, jusqua] = valeurs as [string, string, string];
      const rows = fins.filter((f): f is string => f !== null && f > apres && f <= jusqua).map((f) => ({ date_renouvellement: f }));
      return { rows, rowCount: rows.length };
    },
  };
  const faits: unknown[][] = [];
  const emetteur = { renouvellementProche: async (...a: unknown[]) => void faits.push(a) };
  return { client, requetes, faits, emetteur };
}

describe("tâche de nuit : renouvellements à 30 jours", () => {
  it("[C-346] renouvellement.proche part pour chaque abonnement qui se renouvelle dans 30 jours, une fois par date", async () => {
    const b = banc(["2026-11-23", "2026-11-23"]);
    const n = await signalerRenouvellementsProches(b.client, b.emetteur as never, T, "2026-10-24");
    expect(n).toBe(1);
    expect(b.requetes[0]?.valeurs).toEqual([T, "2026-10-24", "2026-11-23"]);
    expect(b.faits).toHaveLength(1);
    expect(b.faits[0]?.[0]).toMatchObject({ id: "renouvellement:2026-11-23" });
    expect(b.faits[0]?.slice(1)).toEqual([T, "2026-11-23"]);
  });

  it("[C-346] @nuit-manquee une nuit sans exécution ne fait pas perdre le renouvellement : il part à la nuit suivante", async () => {
    const b = banc(["2026-11-23"]);
    // Nuit du 24/10 manquée ; exécution le 25/10 : la fin du 23/11 est à 29 jours.
    const n = await signalerRenouvellementsProches(b.client, b.emetteur as never, T, "2026-10-25");
    expect(n).toBe(1);
    expect(b.faits[0]?.[0]).toMatchObject({ id: "renouvellement:2026-11-23" });
  });

  it("[C-346] la date du fait vient de la date de fin : exécutée un jour ou un autre, le corps est identique", async () => {
    const a = banc(["2026-11-23"]);
    const c = banc(["2026-11-23"]);
    await signalerRenouvellementsProches(a.client, a.emetteur as never, T, "2026-10-24");
    await signalerRenouvellementsProches(c.client, c.emetteur as never, T, "2026-11-02");
    expect(a.faits[0]?.[0]).toEqual(c.faits[0]?.[0]);
    expect(a.faits[0]?.[0]).toMatchObject({ occurredAt: "2026-10-24T00:00:00Z" });
  });

  it("[C-346] une fin passée, au-delà de 30 jours ou absente n'est jamais signalée", async () => {
    const b = banc(["2026-10-24", "2026-10-01", "2026-11-24", null]);
    expect(await signalerRenouvellementsProches(b.client, b.emetteur as never, T, "2026-10-24")).toBe(0);
    expect(b.faits).toHaveLength(0);
  });

  it("[C-346] @abonnement-resilie la requête exclut les abonnements qui s'arrêtent (suite de maintenance : arrêt) et reste limitée au client", async () => {
    const b = banc([]);
    await signalerRenouvellementsProches(b.client, b.emetteur as never, T, "2026-10-24");
    const texte = b.requetes[0]?.texte ?? "";
    expect(texte).toMatch(/a\.tenant_id = \$1/);
    expect(texte).toMatch(/a\.fin > \$2::date AND a\.fin <= \$3::date/);
    expect(texte).toMatch(/suite_maintenance = 'arret'/);
    expect(texte).toMatch(/suite_maintenance = 'reconduction'/);
  });
});
