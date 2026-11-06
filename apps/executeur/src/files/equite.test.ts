import { describe, expect, it } from "vitest";
import type { Palier } from "../config.ts";
import { etaler } from "./etalement.ts";
import { PlafondModule } from "./plafond-module.ts";
import { PlacesMemoire, Semaphore } from "./semaphore.ts";
import { Repartiteur, SousFilesMemoire } from "./tour-de-role.ts";
import { Cellule } from "./cellule.ts";
import { traiter, type Travail } from "./travailleur.ts";

const POIDS: Record<Palier, number> = { essentiel: 1, pro: 2, etendu: 4 };
const travail = (client: string, n: number, palier: Palier = "essentiel", moduleId?: string): Travail & { moduleId?: string } => ({ id: `${client}-${n}`, instanceId: `inst-${client}`, clientId: client, palier, ...(moduleId ? { moduleId } : {}) });

describe("tour de rôle entre clients", () => {
  it("[A-414] un client avec 10 000 travaux en file ne retarde pas un autre client au-delà d'un tour", async () => {
    const r = new Repartiteur(new SousFilesMemoire(), POIDS);
    for (let i = 0; i < 10_000; i++) await r.ajouter(travail("bruyant", i, "etendu"));
    await r.ajouter(travail("calme", 0));
    const sortis: string[] = [];
    for (let i = 0; i < 20; i++) sortis.push((await r.suivant())!.clientId);
    // le client bruyant (poids 4) passe au plus 4 fois avant le client calme
    expect(sortis.indexOf("calme")).toBeGreaterThanOrEqual(0);
    expect(sortis.indexOf("calme")).toBeLessThanOrEqual(POIDS.etendu);
  });

  it("[A-414] aucun client n'attend plus d'un tour complet", async () => {
    const paliers: Palier[] = ["essentiel", "pro", "etendu"];
    const clients = Array.from({ length: 30 }, (_, i) => ({ id: `c${i}`, palier: paliers[i % 3]! }));
    const r = new Repartiteur(new SousFilesMemoire(), POIDS);
    const tour = clients.reduce((s, c) => s + POIDS[c.palier], 0);
    for (const c of clients) for (let i = 0; i < 50; i++) await r.ajouter(travail(c.id, i, c.palier));
    // premier travail de chaque client : il doit sortir avant la fin du premier tour complet
    const sortis: string[] = [];
    for (let i = 0; i < tour; i++) sortis.push((await r.suivant())!.clientId);
    for (const c of clients) expect(sortis).toContain(c.id);
    // et chacun reste servi à chaque tour suivant (pas de famine) : plus aucun client absent d'un tour entier
    const suite: string[] = [];
    for (let i = 0; i < tour; i++) suite.push((await r.suivant())!.clientId);
    for (const c of clients) expect(suite).toContain(c.id);
  });

  it("[A-414] les travaux d'un même client sortent dans l'ordre, rien n'est perdu ni doublé", async () => {
    const r = new Repartiteur(new SousFilesMemoire(), POIDS);
    for (let i = 0; i < 5; i++) for (const c of ["a", "b"]) await r.ajouter(travail(c, i));
    const ids: string[] = [];
    for (let t = await r.suivant(); t; t = await r.suivant()) ids.push(t.id);
    expect(ids.filter((i) => i.startsWith("a-"))).toEqual(["a-0", "a-1", "a-2", "a-3", "a-4"]);
    expect(ids.filter((i) => i.startsWith("b-"))).toEqual(["b-0", "b-1", "b-2", "b-3", "b-4"]);
    expect(ids).toHaveLength(10);
  });

  it("[A-414] la garde des licences interdit les groupes de BullMQ : le tour de rôle est écrit à la main sur des files ordinaires", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("./tour-de-role.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/group/i);
  });
});

describe("plafond par module", () => {
  it("[A-415] une automatisation ne dépasse jamais son plafond de places sur la cellule", async () => {
    const places = new PlacesMemoire(() => 1_000);
    const plafond = new PlafondModule(places, { placesParModule: 3, bailPlaceMs: 60_000 });
    const resultats = await Promise.all(Array.from({ length: 10 }, (_, i) => plafond.acquerir("module-x", `p${i}`)));
    expect(resultats.filter(Boolean)).toHaveLength(3);
    // un autre module n'est pas gêné
    expect(await plafond.acquerir("module-y", "q0")).toBe(true);
    // une place rendue est reprise
    await plafond.liberer("module-x", "p0");
    expect(await plafond.acquerir("module-x", "p-nouveau")).toBe(true);
  });

  it("[A-415] au-delà du plafond, le travail attend sans perte et la place du client est rendue", async () => {
    const places = new PlacesMemoire(() => 1_000);
    const semaphore = new Semaphore(places, { placesParPalier: { essentiel: 8, pro: 8, etendu: 8 }, bailPlaceMs: 60_000 });
    const plafondModule = new PlafondModule(new PlacesMemoire(() => 1_000), { placesParModule: 2, bailPlaceMs: 60_000 });
    const cellule = new Cellule("c1", ["inst-a"]);
    let enCours = 0;
    let max = 0;
    const lib: (() => void)[] = [];
    const executer = async () => {
      max = Math.max(max, ++enCours);
      await new Promise<void>((r) => lib.push(r));
      enCours--;
    };
    const dep = { cellule, semaphore, plafondModule, executer, delaiRemiseMs: 10 };
    const lots = Array.from({ length: 5 }, (_, i) => traiter(travail("a", i, "essentiel", "module-x"), dep));
    await new Promise((r) => setTimeout(r, 20));
    expect(max).toBe(2);
    // trois travaux ont été remis (jamais exécutés, jamais perdus) et leur place de client est rendue
    expect(await semaphore.acquerir("a", "essentiel", "verif-1")).toBe(true);
    lib.forEach((l) => l());
    const issues = await Promise.all(lots);
    expect(issues.filter((i) => i.statut === "remis")).toHaveLength(3);
    expect(issues.filter((i) => i.statut === "fait")).toHaveLength(2);
  });

  it("[A-415] sans plafond configuré (0), rien ne change : interrupteur fermé par défaut", async () => {
    const plafond = new PlafondModule(new PlacesMemoire(() => 1_000), { placesParModule: 0, bailPlaceMs: 60_000 });
    for (let i = 0; i < 50; i++) expect(await plafond.acquerir("module-x", `p${i}`)).toBe(true);
  });
});

describe("sémaphore par client avec le tour de rôle", () => {
  it("[A-325] le sémaphore par client reste respecté avec le tour de rôle", async () => {
    const places = new PlacesMemoire(() => 1_000);
    const semaphore = new Semaphore(places, { placesParPalier: { essentiel: 2, pro: 4, etendu: 8 }, bailPlaceMs: 60_000 });
    const r = new Repartiteur(new SousFilesMemoire(), POIDS);
    for (let i = 0; i < 6; i++) await r.ajouter(travail("a", i));
    for (let i = 0; i < 6; i++) await r.ajouter(travail("b", i, "pro"));
    const cellule = new Cellule("c1", ["inst-a", "inst-b"]);
    const enCours = new Map<string, number>();
    const max = new Map<string, number>();
    const lib: (() => void)[] = [];
    const executer = async (t: Travail) => {
      enCours.set(t.clientId, (enCours.get(t.clientId) ?? 0) + 1);
      max.set(t.clientId, Math.max(max.get(t.clientId) ?? 0, enCours.get(t.clientId)!));
      await new Promise<void>((ok) => lib.push(ok));
      enCours.set(t.clientId, enCours.get(t.clientId)! - 1);
    };
    const lots: Promise<unknown>[] = [];
    for (let t = await r.suivant(); t; t = await r.suivant()) lots.push(traiter(t, { cellule, semaphore, executer, delaiRemiseMs: 1 }));
    await new Promise((ok) => setTimeout(ok, 20));
    expect(max.get("a")).toBe(2);
    expect(max.get("b")).toBe(4);
    lib.forEach((l) => l());
    await Promise.all(lots);
  });
});

describe("heures étalées", () => {
  it("[A-416] 5 000 instances « tous les jours à 8 h » sont étalées sur la fenêtre configurée", () => {
    const minutes = new Map<number, number>();
    for (let i = 0; i < 5_000; i++) {
      const rep = etaler({ pattern: "0 8 * * *", tz: "Europe/Paris" }, `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, 30) as { pattern: string; tz: string };
      const m = /^(\d+) 8 \* \* \*$/.exec(rep.pattern);
      expect(m).not.toBeNull();
      minutes.set(Number(m![1]), (minutes.get(Number(m![1])) ?? 0) + 1);
      expect(rep.tz).toBe("Europe/Paris");
    }
    expect([...minutes.keys()].every((k) => k >= 0 && k < 30)).toBe(true);
    expect(minutes.size).toBe(30);
    // répartition raisonnable : aucune minute ne porte plus du double de la moyenne
    expect(Math.max(...minutes.values())).toBeLessThan((5_000 / 30) * 2);
  });

  it("[A-416] le décalage d'une instance est stable, et sans fenêtre rien ne change", () => {
    const base = { pattern: "0 8 * * *", tz: "Europe/Paris" };
    expect(etaler(base, "inst-1", 30)).toEqual(etaler(base, "inst-1", 30));
    expect(etaler(base, "inst-1", 0)).toEqual(base);
    // un déclencheur par intervalle n'est pas étalé
    expect(etaler({ every: 60_000 }, "inst-1", 30)).toEqual({ every: 60_000 });
    // une expression que l'on ne sait pas décaler sans la changer est laissée telle quelle
    const libre = { pattern: "*/5 * * * *", tz: "Europe/Paris" };
    expect(etaler(libre, "inst-1", 30)).toEqual(libre);
    // le passage de minuit ne change pas le jour d'un déclencheur hebdomadaire
    const tard = etaler({ pattern: "50 23 * * 1", tz: "Europe/Paris" }, "inst-9", 30) as { pattern: string };
    expect(tard.pattern).toMatch(/^\d+ 23 \* \* 1$/);
  });
});
