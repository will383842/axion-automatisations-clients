import { describe, expect, it } from "vitest";
import { chargerConfig } from "../config.ts";
import { Cellule, InstanceHorsCellule } from "./cellule.ts";
import { CurseursMemoire, demandeManuelle, executerSondage, versRepetition } from "./declencheurs.ts";
import { PlanificateursMemoire, synchroniser, type EtatVouluPlanifie } from "./planificateur.ts";
import { PlacesMemoire, Semaphore } from "./semaphore.ts";
import { traiter } from "./travailleur.ts";

const config = chargerConfig({});
const actif = (instanceId: string, declencheurs: EtatVouluPlanifie["declencheurs"]): EtatVouluPlanifie => ({
  instanceId, etat: "actif", arretEnvois: false, version: 1, declencheurs,
});
const cron = { type: "cron", id: "matin", expression: "0 8 * * 1-5" } as const;

describe("planificateur", () => {
  it("[A-311] synchroniser crée un planificateur par instance active et le retire à la pause", async () => {
    const port = new PlanificateurMembre();
    await synchroniser(port, [actif("inst-1", [cron]), actif("inst-2", [cron])]);
    expect([...port.liste()].sort()).toEqual(["inst-1:matin", "inst-2:matin"]);
    await synchroniser(port, [{ ...actif("inst-1", [cron]), etat: "pause" }, { ...actif("inst-2", [cron]), etat: "arrete" }]);
    expect(port.liste()).toEqual([]);
  });
  it("[A-311] synchroniser deux fois de suite ne crée aucun doublon", async () => {
    const port = new PlanificateurMembre();
    const voulus = [actif("inst-1", [cron])];
    await synchroniser(port, voulus);
    const ecritures = port.ecritures;
    await synchroniser(port, voulus);
    expect(port.liste()).toEqual(["inst-1:matin"]);
    expect(port.ecritures).toBe(ecritures);
  });
  it("[A-311] le gabarit du travail ne contient que l'identifiant d'instance, le cron suit le fuseau Europe/Paris", async () => {
    const port = new PlanificateurMembre();
    await synchroniser(port, [actif("inst-1", [cron])]);
    expect(port.dernier?.gabarit).toEqual({ instanceId: "inst-1" });
    expect(versRepetition(cron)).toEqual({ pattern: "0 8 * * 1-5", tz: "Europe/Paris" });
  });
});

// Port de planificateurs aux écritures comptées, pour prouver l'idempotence.
class PlanificateurMembre extends PlanificateursMemoire {}

describe("sémaphore par client", () => {
  const banc = () => {
    const places = new PlacesMemoire(() => t);
    let t = 1_000;
    return { sem: new Semaphore(places, config), avancer: (ms: number) => void (t += ms) };
  };
  it("[A-268] Pro 4, Étendu 8, Essentiel 2", () => {
    expect(config.placesParPalier).toEqual({ essentiel: 2, pro: 4, etendu: 8 });
  });
  it("[A-325] un client Essentiel n'a jamais plus de 2 travaux en cours (100 travaux lancés)", async () => {
    const { sem } = banc();
    const cellule = new Cellule("auto-run-1", ["inst-1", "inst-2"]);
    let enCours = 0;
    let max = 0;
    let faits = 0;
    const executer = async () => {
      enCours++;
      max = Math.max(max, enCours);
      await new Promise((r) => setImmediate(r));
      enCours--;
      faits++;
    };
    const travail = (i: number) => ({ id: `t${i}`, instanceId: i % 2 ? "inst-1" : "inst-2", clientId: "client-a", palier: "essentiel" as const });
    const lancer = async (i: number) => {
      for (;;) {
        const r = await traiter(travail(i), { cellule, semaphore: sem, executer });
        if (r.statut === "fait") return;
        expect(r.delaiMs).toBeGreaterThan(0);
        await new Promise((r2) => setImmediate(r2));
      }
    };
    await Promise.all(Array.from({ length: 100 }, (_, i) => lancer(i)));
    expect(faits).toBe(100);
    expect(max).toBe(2);
  });
  it("[A-325] une place perdue (travailleur tué) revient après l'expiration du bail", async () => {
    const { sem, avancer } = banc();
    expect(await sem.acquerir("client-a", "essentiel", "w1")).toBe(true);
    expect(await sem.acquerir("client-a", "essentiel", "w2")).toBe(true);
    expect(await sem.acquerir("client-a", "essentiel", "w3")).toBe(false);
    avancer(config.bailPlaceMs + 1);
    expect(await sem.acquerir("client-a", "essentiel", "w3")).toBe(true);
  });
  it("[A-325] le sémaphore compte par client : deux instances du même client partagent les places", async () => {
    const { sem } = banc();
    await sem.acquerir("client-a", "essentiel", "inst-1:e1");
    await sem.acquerir("client-a", "essentiel", "inst-2:e2");
    expect(await sem.acquerir("client-a", "essentiel", "inst-3:e3")).toBe(false);
    expect(await sem.acquerir("client-b", "essentiel", "inst-9:e9")).toBe(true);
  });
});

describe("déclencheurs", () => {
  it("[A-292] un sondage reprend à son curseur après redémarrage", async () => {
    const curseurs = new CurseursMemoire();
    const source = ["a", "b", "c", "d"];
    const relever = async (depuis: string | undefined) => {
      const debut = depuis === undefined ? 0 : Number(depuis);
      const elements = source.slice(debut, debut + 2);
      return { elements, curseur: String(debut + elements.length) };
    };
    expect((await executerSondage(curseurs, "inst-1", "boite", relever)).elements).toEqual(["a", "b"]);
    // « redémarrage » : nouveau code, même magasin de curseurs.
    expect((await executerSondage(curseurs, "inst-1", "boite", relever)).elements).toEqual(["c", "d"]);
  });
  it("[A-292] une demande manuelle donne un travail unique, clé = demande", () => {
    expect(demandeManuelle("inst-1", "demande-7")).toEqual(demandeManuelle("inst-1", "demande-7"));
    expect(demandeManuelle("inst-1", "demande-7").jobId).toBe("manuel:inst-1:demande-7");
  });
});

describe("cellule", () => {
  it("[A-052] un travail d'une instance d'une autre cellule est refusé", async () => {
    const { sem } = { sem: new Semaphore(new PlacesMemoire(() => 0), config) };
    const cellule = new Cellule("auto-run-1", ["inst-1"]);
    expect(cellule.nomFile).toBe("executions:auto-run-1");
    let appele = false;
    await expect(
      traiter({ id: "t", instanceId: "inst-autre", clientId: "client-a", palier: "pro" }, { cellule, semaphore: sem, executer: async () => void (appele = true) }),
    ).rejects.toBeInstanceOf(InstanceHorsCellule);
    expect(appele).toBe(false);
  });
});
