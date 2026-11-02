import { describe, expect, it } from "vitest";
import { depotGelsEnMemoire, gelReel, poserGel, type SessionEquipe } from "./gel.js";
import { envoisServiceEnMemoire } from "../envois/service.js";
import { exigerAucunGel, retirerSousGel } from "./garde.js";

const CLIENT = "11111111-1111-4111-8111-111111111111";
const admin: SessionEquipe = { acteur: "will383842", role: "administrateur", organisationId: CLIENT, reauthentifie: true };
function monde() {
  const depot = depotGelsEnMemoire();
  const deps = { depot, envois: envoisServiceEnMemoire(), maintenant: () => new Date("2026-11-02T10:00:00Z"), nouvelId: () => "gel-1" };
  return { depot, deps, gel: gelReel(depot) };
}
const ACTIONS = ["purge", "retrait_dumps", "retrait_exports", "preavis", "mise_a_l_ecart", "effacement"] as const;

describe("garde du gel", () => {
  it("[C-609] tant que le gel court, purge, retrait des dumps et des exports, préavis, mise à l'écart et effacement sont refusés", async () => {
    const { deps, gel } = monde();
    for (const a of ACTIONS) await expect(exigerAucunGel(gel, CLIENT, a)).resolves.toBeUndefined();
    await poserGel(deps, admin, CLIENT, "litige");
    for (const a of ACTIONS) {
      await expect(exigerAucunGel(gel, CLIENT, a)).rejects.toMatchObject({ code: "regle_metier", motif: "gel_pour_litige" });
    }
    // Un autre client n'est pas touché.
    await expect(exigerAucunGel(gel, "33333333-3333-4333-8333-333333333333", "purge")).resolves.toBeUndefined();
  });

  it("[C-609] la levée rouvre les retraits", async () => {
    const { deps, gel } = monde();
    const g = await poserGel(deps, admin, CLIENT, "litige");
    const { leverGel } = await import("./gel.js");
    await leverGel(deps, admin, CLIENT, g.id, "réglé");
    await expect(exigerAucunGel(gel, CLIENT, "effacement")).resolves.toBeUndefined();
  });

  it("[C-609] l'implémentation réelle se déclare réelle pour la rétention", () => {
    expect(monde().gel.estReel).toBe(true);
  });

  it("[C-609] une mise à l'écart et un effacement relisent le gel dans leur transaction finale", async () => {
    const { deps, gel } = monde();
    // Premier contrôle passé, gel posé ensuite : le retrait, qui relit le gel en dernier, est refusé et rien n'est retiré.
    await exigerAucunGel(gel, CLIENT, "effacement");
    await poserGel(deps, admin, CLIENT, "litige");
    let retire = 0;
    await expect(retirerSousGel(gel, CLIENT, "effacement", async () => void retire++)).rejects.toMatchObject({ motif: "gel_pour_litige" });
    expect(retire).toBe(0);
  });

  it("[C-609] le gel est relu avant chaque retrait, juste avant l'exécution", async () => {
    const { gel } = monde();
    const ordre: string[] = [];
    const espion = { estReel: true, gelActif: async (t: string) => (ordre.push(`gel:${t}`), false) };
    await retirerSousGel(espion, CLIENT, "mise_a_l_ecart", async () => void ordre.push("retrait"));
    expect(ordre).toEqual([`gel:${CLIENT}`, "retrait"]);
    expect(gel.estReel).toBe(true);
  });
});
