import { describe, expect, it } from "vitest";
import { depotGelsEnMemoire, gelActif, gelReel, poserGel, type DepotGels, type SessionEquipe } from "./gel.js";
import { purgerExecutions } from "../retention/purger.js";
import { envoisServiceEnMemoire } from "../envois/service.js";
import { exigerAucunGel, retirerSousGel } from "./garde.js";

const CLIENT = "11111111-1111-4111-8111-111111111111";
const admin: SessionEquipe = { acteur: "will383842", role: "administrateur", clientActifId: CLIENT, reauthentifie: true };
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

  it("[C-609] avec le dépôt en mémoire, le gel n'est pas réel et la purge ouverte est refusée ; un dépôt persistant est réel", async () => {
    const { depot, gel } = monde();
    expect(gel.estReel).toBe(false);
    const options = { depot: {} as never, gel, journal: async () => undefined, active: true, maintenant: new Date("2026-11-02T10:00:00Z") };
    await expect(purgerExecutions(options)).rejects.toThrow(/provisoire/);
    const persistant: DepotGels = { ...depot, persistant: true };
    expect(gelReel(persistant).estReel).toBe(true);
  });

  it("[C-609] une mise à l'écart et un effacement lisent le gel et retirent dans la MÊME transaction", async () => {
    const { deps, depot } = monde();
    const tx = { nom: "tx-1" };
    const lus: unknown[] = [];
    const lireGel = async (t: typeof tx, client: string) => (lus.push(t), gelActif(depot, client));
    let retire: unknown = null;
    await retirerSousGel(tx, lireGel, CLIENT, "effacement", async (t) => void (retire = t));
    expect(lus).toEqual([tx]);
    expect(retire).toBe(tx);
    await poserGel(deps, admin, CLIENT, "litige");
    retire = null;
    await expect(retirerSousGel(tx, lireGel, CLIENT, "effacement", async (t) => void (retire = t))).rejects.toMatchObject({ motif: "gel_pour_litige" });
    expect(retire).toBeNull();
  });

  it("[C-609] le gel est relu juste avant le retrait, après toute autre étape", async () => {
    const ordre: string[] = [];
    const lireGel = async (_t: object, c: string) => (ordre.push(`gel:${c}`), false);
    await retirerSousGel({}, lireGel, CLIENT, "mise_a_l_ecart", async () => void ordre.push("retrait"));
    expect(ordre).toEqual([`gel:${CLIENT}`, "retrait"]);
  });
});
