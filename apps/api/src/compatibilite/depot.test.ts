import { describe, expect, it } from "vitest";
import { creerDepotOutils } from "./depot.js";

// Dépôt des outils et du catalogue (T3-17b) : trois requêtes constantes sous console_equipe.
const A = "11111111-1111-4111-8111-111111111111";
function faux(lignes: Record<string, unknown>[] = []) {
  const vus: { texte: string; valeurs: unknown[] }[] = [];
  return { vus, tx: { async query(texte: string, valeurs: unknown[] = []) { vus.push({ texte, valeurs }); return { rows: lignes }; } } };
}

describe("dépôt des outils et du catalogue", () => {
  it("[A-409] la requête des outils est filtrée par le client et nomme ses colonnes", async () => {
    const { vus, tx } = faux([{ famille: "agenda", outil: "microsoft_365", cree_le: new Date("2026-11-07T08:42:37.123Z") }]);
    const r = await creerDepotOutils(tx).outils(A);
    expect(vus[0]?.valeurs).toEqual([A]);
    expect(vus[0]?.texte).toContain("tenant_id = $1");
    expect(vus[0]?.texte).not.toMatch(/\*/);
    expect(vus[0]?.texte).toMatch(/SELECT\s+famille,\s*outil,\s*cree_le/);
    expect(r).toEqual([{ famille: "agenda", outil: "microsoft_365", cree_le: "2026-11-07T08:42Z" }]);
  });

  it("[A-410] la requête du catalogue ne lit que les familles du manifeste, jamais le manifeste entier", async () => {
    const { vus, tx } = faux([{ code: "AUT-101", nom: "Rappel", familles: ["agenda"], manifeste: { secret: "x" } }]);
    const r = await creerDepotOutils(tx).catalogue();
    expect(vus[0]?.texte).toContain("jsonb_path_query_array");
    // Une fois l'extraction retirée, la colonne du manifeste ne figure plus nulle part dans la requête.
    expect((vus[0]?.texte ?? "").replace(/jsonb_path_query_array\([^)]*\)/g, "")).not.toMatch(/manifeste/i);
    expect(vus[0]?.texte).not.toMatch(/\*\s*FROM|SELECT\s+\*/i);
    expect(r).toEqual([{ code: "AUT-101", nom: "Rappel", familles: ["agenda"] }]);
  });
});
