import { describe, expect, it } from "vitest";
import { executerTache, verrouConsultatif } from "./machine.js";

// Dettes de T2-34 soldées par T2-35 : déverrouillage consultatif raté et verrou occupé.
const T = "11111111-2222-4333-8444-555555555555";
function connexion(options: { unlockEchoue?: boolean; verrouPris?: boolean } = {}) {
  const liberations: (boolean | undefined)[] = [];
  const c = {
    query: async (texte: string) => {
      if (/pg_advisory_unlock/.test(texte)) { if (options.unlockEchoue) throw new Error("coupure"); return { rows: [{ ok: true }] }; }
      return { rows: [{ ok: options.verrouPris !== true }] };
    },
    release: (detruire?: boolean) => { liberations.push(detruire); },
  };
  return { c, liberations };
}

describe("verrou consultatif et tâche occupée", () => {
  it("[A-213] un déverrouillage raté détruit la connexion au lieu de la rendre au pool avec son verrou", async () => {
    const { c, liberations } = connexion({ unlockEchoue: true });
    const rendre = await verrouConsultatif(async () => c).prendre(T);
    await expect(rendre!()).rejects.toThrow();
    expect(liberations).toEqual([true]);
  });
  it("[A-213] un déverrouillage réussi rend la connexion normalement", async () => {
    const { c, liberations } = connexion();
    const rendre = await verrouConsultatif(async () => c).prendre(T);
    await rendre!();
    expect(liberations).toEqual([undefined]);
  });
  it("[A-224] une tâche dont le verrou est pris est rendue comme une erreur réessayable", async () => {
    const m = { executer: async () => "occupe" as const };
    await expect(executerTache(m, T)).rejects.toMatchObject({ code: "occupe" });
  });
  it("[A-224] une tâche menée à terme ou ignorée ne lève rien", async () => {
    for (const r of ["a_jour", "ignore", "ligne_absente"] as const) await expect(executerTache({ executer: async () => r }, T)).resolves.toBe(r);
  });
});
