import { describe, expect, it } from "vitest";
import { QuotaAtteint, alerter, pourcentagesBps, verifierImportAutorise, type AlerteQuota, type PortsAlerte } from "./alerter.js";
import type { Mesures } from "./mesurer.js";
import type { Quotas } from "./paliers.js";

const T = "11111111-1111-4111-8111-111111111111";
const QUOTAS: Quotas = { baseOctets: 1_000, fichiersOctets: 2_000, personnes: 100 };
const mesures = (base: number, fichiers = 0, personnes = 0): Mesures => ({ baseOctets: base, fichiersOctets: fichiers, personnes, mesureLe: new Date("2026-11-02T10:00:00Z") });

function ports(depart = "2026-11-02T10:00:00Z") {
  let maintenant = new Date(depart);
  const vues = new Set<string>();
  const envoyees: AlerteQuota[] = [];
  const appels: string[] = [];
  const p: PortsAlerte = {
    async dejaEnvoyee(t, seuil, mois) { appels.push("dejaEnvoyee"); return vues.has(`${t}|${seuil}|${mois}`); },
    async marquer(t, seuil, mois) { appels.push("marquer"); vues.add(`${t}|${seuil}|${mois}`); },
    async envoyer(a) { appels.push("envoyer"); envoyees.push(a); },
    maintenant: () => maintenant,
  };
  return { p, envoyees, appels, avancer: (iso: string) => { maintenant = new Date(iso); } };
}

describe("quotas : alerte à 70 %", () => {
  it("[A-247] les pourcentages se calculent sans flottant, au point de base inférieur", () => {
    expect(pourcentagesBps(mesures(700, 0, 0), QUOTAS).base).toBe(7000);
    expect(pourcentagesBps(mesures(699), QUOTAS).base).toBe(6990);
    expect(pourcentagesBps(mesures(0, 0, 70), QUOTAS).personnes).toBe(7000);
    // Un volume énorme ne perd pas de précision (entier sûr au-delà de 2^53 une fois multiplié).
    const gros = { baseOctets: 4_000_000_000_000_000, fichiersOctets: 1, personnes: 1 };
    expect(pourcentagesBps(mesures(3_000_000_000_000_000), gros).base).toBe(7500);
  });

  it("[A-247] une alerte part à 70 % d'un quota, une seule fois par mois et par seuil", async () => {
    const { p, envoyees, avancer } = ports();
    expect(await alerter(p, T, mesures(699), QUOTAS)).toBeUndefined();
    expect(envoyees).toEqual([]);
    expect(await alerter(p, T, mesures(700), QUOTAS)).toBe("quota_70");
    expect(envoyees).toEqual([{ type: "quota_70", clientId: T, seuil: 70, quotas: ["base"], mois: "2026-11" }]);
    // Mesure suivante, même mois : rien.
    expect(await alerter(p, T, mesures(800), QUOTAS)).toBeUndefined();
    expect(envoyees).toHaveLength(1);
    // N'importe lequel des trois quotas déclenche ; le mois suivant, l'alerte repart.
    avancer("2026-12-01T09:00:00Z");
    expect(await alerter(p, T, mesures(0, 0, 70), QUOTAS)).toBe("quota_70");
    expect(envoyees.at(-1)).toEqual({ type: "quota_70", clientId: T, seuil: 70, quotas: ["personnes"], mois: "2026-12" });
    // Le seuil de 100 % a son propre compteur : il part même après celui de 70 %.
    expect(await alerter(p, T, mesures(0, 0, 100), QUOTAS)).toBe("quota_atteint");
  });

  it("[A-247] le mois est celui d'Europe/Paris et une alerte ne porte ni nom de client ni mesure brute", async () => {
    const { p, envoyees } = ports("2026-10-31T23:30:00Z"); // déjà le 1er novembre à Paris
    await alerter(p, T, mesures(900), QUOTAS);
    expect(envoyees[0]!.mois).toBe("2026-11");
    expect(Object.keys(envoyees[0]!).sort()).toEqual(["clientId", "mois", "quotas", "seuil", "type"]);
  });

  it("[A-247] un client est alerté séparément d'un autre", async () => {
    const { p, envoyees } = ports();
    const AUTRE = "22222222-2222-4222-8222-222222222222";
    await alerter(p, T, mesures(900), QUOTAS);
    await alerter(p, AUTRE, mesures(900), QUOTAS);
    expect(envoyees.map((a) => a.clientId)).toEqual([T, AUTRE]);
  });

  it("[A-247] si l'envoi échoue, rien n'est marqué : l'alerte repart à la mesure suivante", async () => {
    const { p, envoyees } = ports();
    let echec = true;
    const reel = p.envoyer;
    p.envoyer = async (a) => { if (echec) throw new Error("panne"); await reel(a); };
    await expect(alerter(p, T, mesures(900), QUOTAS)).rejects.toThrow();
    echec = false;
    expect(await alerter(p, T, mesures(900), QUOTAS)).toBe("quota_70");
    expect(envoyees).toHaveLength(1);
  });
});

describe("quotas : blocage doux à 100 %", () => {
  it("[A-248] à 100 %, les nouveaux imports sont refusés, rien n'est supprimé ni arrêté", async () => {
    for (const m of [mesures(1_000), mesures(0, 2_000), mesures(0, 0, 100), mesures(5_000)]) {
      let erreur: unknown;
      try { verifierImportAutorise(m, QUOTAS); } catch (e) { erreur = e; }
      expect(erreur).toBeInstanceOf(QuotaAtteint);
      expect(erreur).toMatchObject({ code: "regle_metier", motif: "quota_atteint" });
    }
    expect(() => verifierImportAutorise(mesures(999, 1_999, 99), QUOTAS)).not.toThrow();
    // Ni l'alerte ni la vérification ne touchent à autre chose qu'un journal d'envoi : trois ports, aucun port de suppression ni d'arrêt.
    const { p, envoyees, appels } = ports();
    expect(await alerter(p, T, mesures(1_000), QUOTAS)).toBe("quota_atteint");
    expect(envoyees.map((a) => a.type)).toEqual(["quota_atteint"]);
    expect(new Set(appels)).toEqual(new Set(["dejaEnvoyee", "envoyer", "marquer"]));
    expect(Object.keys(p).sort()).toEqual(["dejaEnvoyee", "envoyer", "marquer", "maintenant"]);
  });

  it("[A-248] le refus ne dit que le motif : ni mesure, ni quota, ni client", () => {
    try { verifierImportAutorise(mesures(1_000), QUOTAS); } catch (e) {
      const t = JSON.stringify({ message: (e as Error).message, motif: (e as QuotaAtteint).motif });
      expect(t).not.toMatch(/\d{3,}/);
      expect(t).toContain("quota_atteint");
    }
    expect.hasAssertions();
  });
});
