import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { decider, mesurer, type Etat } from "./sonde.ts";

// Attaques et pannes : le serveur se tait (une fois, puis longtemps) ; une réponse lente ; une réponse 500 ; une réponse illisible ;
// la sauvegarde absente ou trop vieille alors que le serveur répond ; l'alerte répétée à chaque passage ; l'alerte qui ne peut pas partir.
const DEPART: Etat = { echecs: 0, muetAlerte: false, sauvegardeAlerte: false };
const H = 3600;
const frais = (maintenant: number) => ({ repondu: true, derniereSauvegardeS: maintenant - 2 * H });
const MUET = { repondu: false };

describe("sonde extérieure (décisions)", () => {
  it("[C-602] un seul échec n'alerte pas, le deuxième alerte (serveur muet)", () => {
    const a = decider(DEPART, MUET, 1000);
    expect(a.alertes).toEqual([]);
    const b = decider(a.etat, MUET, 1060);
    expect(b.alertes.map((x) => x.type)).toEqual(["serveur_muet"]);
    expect(b.alertes[0]?.niveau).toBe("reveil");
  });
  it("[C-602] l'alerte n'est pas répétée à chaque passage, puis le retour est signalé", () => {
    let e = decider(decider(DEPART, MUET, 1).etat, MUET, 2).etat;
    expect(decider(e, MUET, 3).alertes).toEqual([]);
    const r = decider(e, frais(100 * H), 100 * H);
    expect(r.alertes.map((x) => x.type)).toEqual(["serveur_revenu"]);
    e = r.etat;
    expect(decider(e, frais(101 * H), 101 * H).alertes).toEqual([]);
  });
  it("[C-602] une absence de sauvegarde ou une sauvegarde de plus de 26 heures lève l'alerte, une seule fois", () => {
    const vieille = { repondu: true, derniereSauvegardeS: 100 * H - 27 * H };
    const a = decider(DEPART, vieille, 100 * H);
    expect(a.alertes.map((x) => x.type)).toEqual(["sauvegarde_absente"]);
    expect(decider(a.etat, vieille, 101 * H).alertes).toEqual([]);
    expect(decider(DEPART, { repondu: true }, 100 * H).alertes.map((x) => x.type)).toEqual(["sauvegarde_absente"]);
    expect(decider(DEPART, { repondu: true, derniereSauvegardeS: 100 * H - 25 * H }, 100 * H).alertes).toEqual([]);
  });
  it("[C-602] une date de sauvegarde dans le futur ou non numérique compte comme absente", () => {
    expect(decider(DEPART, { repondu: true, derniereSauvegardeS: 200 * H }, 100 * H).alertes.map((x) => x.type)).toEqual(["sauvegarde_absente"]);
    expect(decider(DEPART, { repondu: true, derniereSauvegardeS: Number.NaN }, 100 * H).alertes.map((x) => x.type)).toEqual(["sauvegarde_absente"]);
  });
  it("[C-602] aucun message d'alerte ne porte d'adresse ni de nom d'hôte", () => {
    const m = decider(decider(DEPART, MUET, 1).etat, MUET, 2).alertes[0]?.message ?? "";
    expect(m).not.toMatch(/https?:|\d+\.\d+\.\d+\.\d+/);
  });
});

describe("sonde extérieure (mesure)", () => {
  const rep = (statut: number, corps: string) => (async () => new Response(corps, { status: statut })) as unknown as typeof fetch;
  it("[C-602] une réponse 200 avec la date de sauvegarde est lue", async () => {
    expect(await mesurer("https://sonde.test/sante", rep(200, '{"derniereSauvegarde":1700000000}'), 500)).toEqual({ repondu: true, derniereSauvegardeS: 1700000000 });
  });
  it("[C-602] 500, panne réseau et délai dépassé comptent comme « ne répond pas »", async () => {
    expect((await mesurer("https://sonde.test/", rep(500, ""), 500)).repondu).toBe(false);
    expect((await mesurer("https://sonde.test/", (async () => { throw new Error("x"); }) as unknown as typeof fetch, 500)).repondu).toBe(false);
    const lent = ((_u: string, o: { signal: AbortSignal }) => new Promise((_ok, ko) => o.signal.addEventListener("abort", () => ko(new Error("delai"))))) as unknown as typeof fetch;
    expect((await mesurer("https://sonde.test/", lent, 50)).repondu).toBe(false);
  });
  it("[C-602] une réponse 200 illisible : le serveur répond mais la sauvegarde est inconnue", async () => {
    expect(await mesurer("https://sonde.test/", rep(200, "<html>"), 500)).toEqual({ repondu: true });
  });
});

describe("sonde extérieure (programme)", () => {
  it("[C-602] sans commande d'alerte ou sans adresse, le programme échoue visiblement", () => {
    const f = fileURLToPath(new URL("./sonde.ts", import.meta.url));
    const r = spawnSync(process.execPath, [f], { encoding: "utf8", env: { PATH: process.env.PATH ?? "" } });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/SONDE_URL|ALERTE_COMMANDE/);
  });
});
