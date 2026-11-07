import { describe, expect, it } from "vitest";
import { nomBaseDe } from "../../provisionnement/etapes-base.js";
import type { PortsReleve } from "../bases/releve.js";
import { planifierReleveHoraire, releverBaseDuClient, releverLotJournalise, traiterTacheReleve } from "./releve.js";

const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";
const maintenant = new Date("2026-11-06T12:00:00Z");

function ports(lectures: string[], surcharge: Partial<PortsReleve> = {}): PortsReleve {
  return {
    tailleBase: async (b) => (lectures.push(b), 5_000_000),
    quotaOctets: async () => 100_000_000,
    connexions: async () => ({ actives: 6, limite: 20 }),
    lignesMortes: async () => 120,
    requetesLentes: async () => 3,
    versionStructure: async () => "modele_v1",
    ageSauvegardeS: async () => 3_600,
    ageTestRestaurationS: async () => 86_400,
    ecrire: async () => undefined,
    maintenant: () => maintenant,
    ...surcharge,
  };
}

function fileEspion() {
  const taches: { nom: string; jobId: string | undefined }[] = [];
  return { taches, file: { name: "t", add: async (nom: string, _d: unknown, o?: { jobId?: string }) => void taches.push({ nom, jobId: o?.jobId }) } };
}

describe("relève horaire des bases", () => {
  it("[A-263] la tâche horaire releve_base relève chaque base une fois par heure", async () => {
    const { taches, file } = fileEspion();
    const bases = [{ tenantId: T1, nomBase: nomBaseDe(T1) }, { tenantId: T2, nomBase: nomBaseDe(T2) }];
    await planifierReleveHoraire(file, bases, maintenant);
    await planifierReleveHoraire(file, bases, new Date("2026-11-06T12:40:00Z"));
    expect(taches.every((t) => t.nom === "releve_base")).toBe(true);
    expect(new Set(taches.map((t) => t.jobId)).size).toBe(2); // même heure : 2 tâches distinctes seulement
    await planifierReleveHoraire(file, bases, new Date("2026-11-06T13:00:00Z"));
    expect(new Set(taches.map((t) => t.jobId)).size).toBe(4); // heure suivante : de nouvelles tâches
  });

  it("[A-263] le traitement d'une tâche releve_base relève la base de la tâche", async () => {
    const lectures: string[] = [];
    await traiterTacheReleve(ports(lectures), { name: "releve_base", data: { tenantId: T1, nomBase: nomBaseDe(T1) } });
    expect(lectures).toEqual([nomBaseDe(T1)]);
    await expect(traiterTacheReleve(ports(lectures), { name: "autre", data: { tenantId: T1, nomBase: nomBaseDe(T1) } })).rejects.toThrow();
  });

  it("[A-263] @isolation une base qui n'est pas celle du client (nomBaseDe) est refusée sans être lue", async () => {
    const lectures: string[] = [];
    await expect(releverBaseDuClient(ports(lectures), { tenantId: T1, nomBase: nomBaseDe(T2) })).rejects.toThrow(/base_autre_client/);
    expect(lectures).toEqual([]);
  });

  it("[A-263] une base en échec est journalisée par code, sans secret, et les autres sont relevées", async () => {
    const lectures: string[] = [];
    const journal: { code: string; base: string }[] = [];
    const p = ports(lectures, { tailleBase: async (b) => { if (b === nomBaseDe(T1)) throw new Error("connexion postgres://u:motdepasse@hote refusée pour anne@exemple.fr"); lectures.push(b); return 1; } });
    const r = await releverLotJournalise(p, [{ tenantId: T1, nomBase: nomBaseDe(T1) }, { tenantId: T2, nomBase: nomBaseDe(T2) }, { tenantId: T2, nomBase: nomBaseDe(T1) }], (code, base) => journal.push({ code, base }));
    expect(r.relevees).toBe(1);
    expect(journal).toEqual([{ code: "lecture_impossible", base: nomBaseDe(T1) }, { code: "base_autre_client", base: nomBaseDe(T1) }]);
    expect(JSON.stringify(journal)).not.toMatch(/motdepasse|exemple\.fr/);
  });
});
