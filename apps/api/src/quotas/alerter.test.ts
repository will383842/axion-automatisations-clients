import { describe, expect, it } from "vitest";
import { QuotaAtteint, alerter, debutPeriode, pourcentagesBps, verifierImportAutorise, type AlerteQuota, type PortsAlerte } from "./alerter.js";
import type { Mesures } from "./mesurer.js";
import type { Quotas } from "./paliers.js";

const T = "11111111-1111-4111-8111-111111111111";
const QUOTAS: Quotas = { baseOctets: 1_000, fichiersOctets: 2_000, personnes: 100 };
const mesures = (base: number, fichiers = 0, personnes = 0): Mesures => ({ baseOctets: base, fichiersOctets: fichiers, personnes, mesureLe: new Date("2026-11-02T10:00:00Z") });

function ports(depart = "2026-11-02T10:00:00Z", souscription = "2026-01-01") {
  let maintenant = new Date(depart);
  const reservees = new Set<string>();
  const envoyees: AlerteQuota[] = [];
  const appels: string[] = [];
  const p: PortsAlerte = {
    async souscritLe() { return souscription; },
    async reserver(t, seuil, periode) { appels.push("reserver"); const k = `${t}|${seuil}|${periode}`; if (reservees.has(k)) return false; reservees.add(k); return true; },
    async liberer(t, seuil, periode) { appels.push("liberer"); reservees.delete(`${t}|${seuil}|${periode}`); },
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

  it("[A-247] une alerte part à 70 % d'un quota, une seule fois par période d'abonnement et par seuil", async () => {
    const { p, envoyees, avancer } = ports();
    expect(await alerter(p, T, mesures(699), QUOTAS)).toBeUndefined();
    expect(envoyees).toEqual([]);
    expect(await alerter(p, T, mesures(700), QUOTAS)).toBe("quota_70");
    expect(envoyees).toEqual([{ type: "quota_70", clientId: T, seuil: 70, quotas: ["base"], periode: "2026-11-01" }]);
    // Mesure suivante, même mois : rien.
    expect(await alerter(p, T, mesures(800), QUOTAS)).toBeUndefined();
    expect(envoyees).toHaveLength(1);
    // N'importe lequel des trois quotas déclenche ; le mois suivant, l'alerte repart.
    avancer("2026-12-01T09:00:00Z");
    expect(await alerter(p, T, mesures(0, 0, 70), QUOTAS)).toBe("quota_70");
    expect(envoyees.at(-1)).toEqual({ type: "quota_70", clientId: T, seuil: 70, quotas: ["personnes"], periode: "2026-12-01" });
    // Le seuil de 100 % a son propre compteur : il part même après celui de 70 %.
    expect(await alerter(p, T, mesures(0, 0, 100), QUOTAS)).toBe("quota_atteint");
  });

  it("[A-247] la période est calculée sur la date d'Europe/Paris et une alerte ne porte ni nom de client ni mesure brute", async () => {
    const { p, envoyees } = ports("2026-10-31T23:30:00Z"); // déjà le 1er novembre à Paris
    await alerter(p, T, mesures(900), QUOTAS);
    expect(envoyees[0]!.periode).toBe("2026-11-01");
    expect(Object.keys(envoyees[0]!).sort()).toEqual(["clientId", "periode", "quotas", "seuil", "type"]);
  });

  it("[A-247] un client est alerté séparément d'un autre", async () => {
    const { p, envoyees } = ports();
    const AUTRE = "22222222-2222-4222-8222-222222222222";
    await alerter(p, T, mesures(900), QUOTAS);
    await alerter(p, AUTRE, mesures(900), QUOTAS);
    expect(envoyees.map((a) => a.clientId)).toEqual([T, AUTRE]);
  });

  it("[A-247] si l'envoi échoue, la réservation est libérée : l'alerte repart à la mesure suivante", async () => {
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

describe("quotas : période = date anniversaire de l'abonnement", () => {
  it("[A-247] debutPeriode : jour anniversaire, mois courts ramenés au dernier jour", () => {
    expect(debutPeriode("2026-01-15", "2026-10-31")).toBe("2026-10-15");
    expect(debutPeriode("2026-01-15", "2026-11-01")).toBe("2026-10-15");
    expect(debutPeriode("2026-01-15", "2026-11-14")).toBe("2026-10-15");
    expect(debutPeriode("2026-01-15", "2026-11-15")).toBe("2026-11-15");
    expect(debutPeriode("2026-01-31", "2026-02-27")).toBe("2026-01-31");
    expect(debutPeriode("2026-01-31", "2026-02-28")).toBe("2026-02-28");
    expect(debutPeriode("2026-01-31", "2026-03-30")).toBe("2026-02-28");
    expect(debutPeriode("2026-01-31", "2026-03-31")).toBe("2026-03-31");
    expect(debutPeriode("2026-01-31", "2026-04-30")).toBe("2026-04-30");
    expect(debutPeriode("2026-01-31", "2026-05-30")).toBe("2026-04-30");
    expect(debutPeriode("2024-01-31", "2024-02-29")).toBe("2024-02-29");
    expect(debutPeriode("2026-11-02", "2026-11-02")).toBe("2026-11-02");
    expect(debutPeriode("2026-12-31", "2027-01-30")).toBe("2026-12-31");
  });

  it("[A-247] abonnement le 15 : 70 % franchi le 31/10 → une seule alerte, aucune seconde au 01/11", async () => {
    const { p, envoyees, avancer } = ports("2026-10-31T10:00:00Z", "2026-01-15");
    expect(await alerter(p, T, mesures(800), QUOTAS)).toBe("quota_70");
    avancer("2026-11-01T10:00:00Z");
    expect(await alerter(p, T, mesures(800), QUOTAS)).toBeUndefined();
    expect(envoyees).toHaveLength(1);
    expect(envoyees[0]!.periode).toBe("2026-10-15");
  });

  it("[A-247] l'alerte du 14/11 ne bloque pas la période suivante (à partir du 15/11)", async () => {
    const { p, envoyees, avancer } = ports("2026-11-14T10:00:00Z", "2026-01-15");
    expect(await alerter(p, T, mesures(800), QUOTAS)).toBe("quota_70");
    avancer("2026-11-15T10:00:00Z");
    expect(await alerter(p, T, mesures(800), QUOTAS)).toBe("quota_70");
    expect(envoyees.map((a) => a.periode)).toEqual(["2026-10-15", "2026-11-15"]);
  });

  it("[A-247] souscription un 31 : février et avril se terminent au dernier jour du mois", async () => {
    const { p, envoyees, avancer } = ports("2026-02-27T10:00:00Z", "2026-01-31");
    await alerter(p, T, mesures(800), QUOTAS);
    avancer("2026-02-28T10:00:00Z");
    await alerter(p, T, mesures(800), QUOTAS);
    avancer("2026-03-30T10:00:00Z");
    expect(await alerter(p, T, mesures(800), QUOTAS)).toBeUndefined();
    avancer("2026-03-31T10:00:00Z");
    await alerter(p, T, mesures(800), QUOTAS);
    expect(envoyees.map((a) => a.periode)).toEqual(["2026-01-31", "2026-02-28", "2026-03-31"]);
  });

  it("[A-247] deux alerter simultanés → un seul envoi (réservation atomique avant l'envoi)", async () => {
    const { p, envoyees } = ports();
    const lente = p.envoyer;
    p.envoyer = async (a) => { await new Promise((r) => setTimeout(r, 5)); await lente(a); };
    const resultats = await Promise.all([alerter(p, T, mesures(800), QUOTAS), alerter(p, T, mesures(800), QUOTAS)]);
    expect(resultats.filter((r) => r === "quota_70")).toHaveLength(1);
    expect(envoyees).toHaveLength(1);
  });

  it("[A-247] si l'envoi échoue, la réservation est libérée (et l'erreur remonte)", async () => {
    const { p, appels } = ports();
    p.envoyer = async () => { throw new Error("panne"); };
    await expect(alerter(p, T, mesures(800), QUOTAS)).rejects.toThrow("panne");
    expect(appels).toEqual(["reserver", "liberer"]);
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
    expect(new Set(appels)).toEqual(new Set(["reserver", "envoyer"]));
    expect(Object.keys(p).sort()).toEqual(["envoyer", "liberer", "maintenant", "reserver", "souscritLe"]);
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
