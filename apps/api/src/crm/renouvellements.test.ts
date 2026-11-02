import { describe, expect, it } from "vitest";
import { signalerRenouvellementsProches } from "./renouvellements.ts";

const T = "11111111-1111-4111-8111-111111111111";
// Faux client : renvoie les dates données. Les bornes et le sens de « résilié » se jouent en base (renouvellements.int.test.ts, job socle-integration).
function banc(dates: string[]) {
  const requetes: { texte: string; valeurs: unknown[] }[] = [];
  const client = {
    query: async (texte: string, valeurs: unknown[] = []) => {
      requetes.push({ texte, valeurs });
      return { rows: dates.map((d) => ({ date_renouvellement: d })), rowCount: dates.length };
    },
  };
  const faits: unknown[][] = [];
  const emetteur = { renouvellementProche: async (...a: unknown[]) => void faits.push(a) };
  return { client, requetes, faits, emetteur };
}

describe("tâche de nuit : renouvellements à 30 jours", () => {
  it("[C-346] un seul fait par date de renouvellement, même avec plusieurs abonnements à cette date", async () => {
    const b = banc(["2026-11-23", "2026-11-23"]);
    const n = await signalerRenouvellementsProches(b.client, b.emetteur as never, T);
    expect(n).toBe(1);
    expect(b.faits).toHaveLength(1);
    expect(b.faits[0]?.[0]).toMatchObject({ id: "renouvellement:2026-11-23" });
    expect(b.faits[0]?.[1]).toBe("2026-11-23");
  });

  it("[C-346] la date du fait vient de la date de fin (fin − 30 jours), jamais du jour d'exécution", async () => {
    const b = banc(["2026-11-23"]);
    await signalerRenouvellementsProches(b.client, b.emetteur as never, T);
    expect(b.faits[0]?.[0]).toMatchObject({ occurredAt: "2026-10-24T00:00:00Z" });
  });

  it("[C-346] @fuseau le jour et les bornes sont calculés par la base en Europe/Paris : l'application ne passe aucune date", async () => {
    const b = banc([]);
    await signalerRenouvellementsProches(b.client, b.emetteur as never, T);
    expect(b.requetes[0]?.valeurs).toEqual([T, 30]);
    const texte = b.requetes[0]?.texte ?? "";
    expect(texte).toMatch(/a\.tenant_id = \$1/);
    expect(texte).toContain("(now() AT TIME ZONE 'Europe/Paris')::date");
    expect(texte).toMatch(/a\.fin > \(now\(\) AT TIME ZONE 'Europe\/Paris'\)::date AND a\.fin <= \(now\(\) AT TIME ZONE 'Europe\/Paris'\)::date \+ \$2::int/);
  });
});
