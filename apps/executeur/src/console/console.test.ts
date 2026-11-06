import { describe, expect, it } from "vitest";
import { EN_TETES, signer } from "@axion-auto/contrats/src/commun/signature.ts";
import { Cellule } from "../files/cellule.ts";
import { declencher, reprendreDeclenchements, type Declenchement } from "../files/planificateur.ts";
import { traiter, type Dependances, type Travail } from "../files/travailleur.ts";
import { CacheReglages } from "./cache.ts";
import { ClientConsole } from "./client.ts";
import { GardeEtatVoulu } from "./etat-voulu.ts";
import { appliquerPoussee, canalPoussees } from "./poussees.ts";
import { AttenteEnPause, PauseSure, UNE_JOURNEE_MS, type Alertes } from "./pause-sure.ts";

const INSTANCE = "inst-1";
class Horloge {
  ms = 0;
  maintenant = () => this.ms;
}
class AlertesNotees implements Alertes {
  codes: string[] = [];
  alerter(code: string) {
    this.codes.push(code);
  }
}
const etat = (e: "actif" | "pause" | "arrete" = "actif", arretEnvois = false) => ({ instanceId: INSTANCE, etat: e, arretEnvois, version: 1 });
const consoleDe = (reponse: () => Promise<ReturnType<typeof etat>>) => ({ lireEtatVoulu: reponse });
function monter(reponse: () => Promise<ReturnType<typeof etat>>) {
  const h = new Horloge();
  const alertes = new AlertesNotees();
  const pause = new PauseSure({ alertes, maintenantMs: h.maintenant });
  const garde = new GardeEtatVoulu({ console: consoleDe(reponse), pause, maintenantMs: h.maintenant });
  return { h, alertes, pause, garde };
}
const travail: Travail = { id: "exec-1", instanceId: INSTANCE, clientId: "cli-1", palier: "pro" };
function dependances(garde: GardeEtatVoulu, demarres: string[]): Dependances {
  const semaphore = { acquerir: async () => true, prolonger: async () => true, liberer: async () => undefined, bailMs: 60_000 };
  return { cellule: new Cellule("c1", [INSTANCE]), semaphore: semaphore as never, executer: async (t) => void demarres.push(t.id), garde: (id) => garde.lire(id) };
}

describe("état voulu lu avant chaque exécution", () => {
  it("[A-341] une instance passée en pause ne démarre plus à l'exécution suivante", async () => {
    let voulu: "actif" | "pause" = "actif";
    const { garde } = monter(async () => etat(voulu));
    const demarres: string[] = [];
    expect((await traiter(travail, dependances(garde, demarres))).statut).toBe("fait");
    voulu = "pause";
    expect((await traiter({ ...travail, id: "exec-2" }, dependances(garde, demarres))).statut).toBe("remis");
    expect(demarres).toEqual(["exec-1"]);
  });

  it("[A-285] redémarrage de l'exécuteur : l'état voulu est relu avant tout travail", async () => {
    let lectures = 0;
    const { garde } = monter(async () => (lectures++, etat("pause")));
    const demarres: string[] = [];
    await traiter(travail, dependances(garde, demarres));
    expect(lectures).toBe(1);
    expect(demarres).toEqual([]);
  });

  it("[A-285] console muette dès le démarrage et rien de connu : rien ne démarre", async () => {
    const { garde } = monter(async () => Promise.reject(new Error("muette")));
    const demarres: string[] = [];
    expect((await traiter(travail, dependances(garde, demarres))).statut).toBe("remis");
    expect(demarres).toEqual([]);
  });
});

describe("pause sûre", () => {
  it("[A-342] console muette 24 h et 1 min : pause sûre et alerte", async () => {
    let muette = false;
    const { h, alertes, garde } = monter(async () => (muette ? Promise.reject(new Error("muette")) : etat()));
    expect((await garde.lire(INSTANCE)).etat).toBe("actif");
    muette = true;
    h.ms = UNE_JOURNEE_MS - 1000;
    expect((await garde.lire(INSTANCE)).etat).toBe("actif"); // dernier état connu, moins de 24 h
    h.ms = UNE_JOURNEE_MS + 60_000;
    expect((await garde.lire(INSTANCE)).etat).toBe("pause");
    await garde.lire(INSTANCE);
    expect(alertes.codes).toEqual(["console_muette_pause_sure"]); // une seule alerte par épisode
  });

  it("[A-342] la console revient : reprise sans intervention", async () => {
    let muette = false;
    const { h, alertes, garde } = monter(async () => (muette ? Promise.reject(new Error("muette")) : etat()));
    await garde.lire(INSTANCE);
    muette = true;
    h.ms = UNE_JOURNEE_MS + 60_000;
    expect((await garde.lire(INSTANCE)).etat).toBe("pause");
    muette = false;
    expect((await garde.lire(INSTANCE)).etat).toBe("actif");
    muette = true;
    h.ms += UNE_JOURNEE_MS + 60_000; // un nouvel épisode alerte de nouveau
    await garde.lire(INSTANCE);
    expect(alertes.codes).toHaveLength(2);
  });
});

describe("poussées et cache", () => {
  it("[A-340] une pause poussée est appliquée en moins de 5 s", async () => {
    const { h, garde } = monter(async () => Promise.reject(new Error("muette")));
    const cache = new CacheReglages<string>(() => h.ms);
    await cache.lire(INSTANCE, async () => ({ valeur: "x", dureeSecondes: 3600 }));
    const avant = Date.now();
    expect(appliquerPoussee(JSON.stringify({ type: "pause", instanceId: INSTANCE }), { garde, cache })).toBe(true);
    expect(Date.now() - avant).toBeLessThan(5000);
    expect((await garde.lire(INSTANCE)).etat).toBe("pause");
    let rechargements = 0;
    await cache.lire(INSTANCE, async () => (rechargements++, { valeur: "y", dureeSecondes: 3600 }));
    expect(rechargements).toBe(1); // le cache a été vidé
  });

  it("[A-340] arrêt des envois et reprise poussés ; message mal formé ignoré", async () => {
    const { garde, h } = monter(async () => Promise.reject(new Error("muette")));
    const cache = new CacheReglages<string>(() => h.ms);
    appliquerPoussee(JSON.stringify({ type: "arret_envois", instanceId: INSTANCE }), { garde, cache });
    expect((await garde.lire(INSTANCE)).arretEnvois).toBe(true);
    appliquerPoussee(JSON.stringify({ type: "reprise", instanceId: INSTANCE }), { garde, cache });
    expect((await garde.lire(INSTANCE)).etat).toBe("actif");
    for (const brut of ["pas du json", JSON.stringify({ type: "x", instanceId: INSTANCE }), JSON.stringify({ type: "pause", instanceId: "a b" }), JSON.stringify({ type: "pause", instanceId: INSTANCE, extra: 1 })]) {
      expect(appliquerPoussee(brut, { garde, cache })).toBe(false);
    }
    expect(canalPoussees("auto-run-1")).toBe("executeur:poussees:auto-run-1");
  });

  it("[A-340] les réglages ne sont jamais servis depuis un cache de plus de 24 h", async () => {
    const h = new Horloge();
    const cache = new CacheReglages<number>(h.maintenant);
    let n = 0;
    const charger = async () => ({ valeur: ++n, dureeSecondes: 999_999 }); // la console demande plus que 24 h
    expect(await cache.lire(INSTANCE, charger)).toBe(1);
    h.ms = UNE_JOURNEE_MS - 1;
    expect(await cache.lire(INSTANCE, charger)).toBe(1);
    h.ms = UNE_JOURNEE_MS;
    expect(await cache.lire(INSTANCE, charger)).toBe(2);
  });

  it("[A-340] la durée renvoyée par la console, si plus courte, prime", async () => {
    const h = new Horloge();
    const cache = new CacheReglages<number>(h.maintenant);
    let n = 0;
    const charger = async () => ({ valeur: ++n, dureeSecondes: 60 });
    await cache.lire(INSTANCE, charger);
    h.ms = 60_000;
    expect(await cache.lire(INSTANCE, charger)).toBe(2);
  });
});

describe("déclenchements gardés pendant une pause", () => {
  const ajout = () => {
    const ajoutes: string[] = [];
    return { ajoutes, ajouter: async (d: Declenchement) => void ajoutes.push(d.jobId) };
  };
  it("[B-437] 30 déclenchements pendant une pause sont traités dans l'ordre après la reprise", async () => {
    let voulu: "actif" | "pause" = "pause";
    const { garde, alertes } = monter(async () => etat(voulu));
    const attente = new AttenteEnPause<Declenchement>(1000, alertes);
    const { ajoutes, ajouter } = ajout();
    for (let i = 1; i <= 30; i++) expect(await declencher({ garde: (id) => garde.lire(id), attente, ajouter }, { instanceId: INSTANCE, jobId: `j${i}` })).toBe("garde");
    expect(ajoutes).toEqual([]);
    voulu = "actif";
    expect(await reprendreDeclenchements({ garde: (id) => garde.lire(id), attente, ajouter }, INSTANCE)).toBe(30);
    expect(ajoutes).toEqual(Array.from({ length: 30 }, (_, i) => `j${i + 1}`));
  });

  it("[B-437] au-delà de la limite : refus compté et alerte, aucun déclenchement effacé", async () => {
    const { garde, alertes } = monter(async () => etat("pause"));
    const attente = new AttenteEnPause<Declenchement>(3, alertes);
    const { ajoutes, ajouter } = ajout();
    const sorties: string[] = [];
    for (let i = 1; i <= 5; i++) sorties.push(await declencher({ garde: (id) => garde.lire(id), attente, ajouter }, { instanceId: INSTANCE, jobId: `j${i}` }));
    expect(sorties).toEqual(["garde", "garde", "garde", "refuse", "refuse"]);
    expect(attente.refuses).toBe(2);
    expect(alertes.codes).toContain("file_pause_pleine");
    expect(attente.taille(INSTANCE)).toBe(3); // les 3 gardés restent
    expect(ajoutes).toEqual([]);
  });

  it("[B-437] la limite est une valeur de configuration sans défaut", () => {
    expect(() => new AttenteEnPause<Declenchement>(Number.NaN, new AlertesNotees())).toThrow();
    expect(() => new AttenteEnPause<Declenchement>(0, new AlertesNotees())).toThrow();
  });
});

describe("client signé de la console", () => {
  it("[A-285] chaque essai est re-signé et la lecture rend l'état voulu validé", async () => {
    const vus: { horodatage: string; signature: string; cle: string }[] = [];
    let appels = 0;
    const faux = (async (url: string, init: RequestInit) => {
      const h = init.headers as Record<string, string>;
      vus.push({ horodatage: h[EN_TETES.horodatage]!, signature: h[EN_TETES.signature]!, cle: h[EN_TETES.cle]! });
      expect(init.method).toBe("GET");
      if (++appels === 1) return new Response("", { status: 503 });
      expect(new URL(url).pathname).toBe(`/api/executeur/v1/instances/${INSTANCE}/etat-voulu`);
      return new Response(JSON.stringify(etat("pause")), { status: 200 });
    }) as unknown as typeof fetch;
    const client = new ClientConsole({ url: "http://console.test", cle: "c4:auto-run-1:1", secret: () => "secret-de-test", jeton: () => "jeton", fetch: faux, maintenant: () => 1_700_000_000, dormir: async () => undefined });
    expect((await client.lireEtatVoulu(INSTANCE)).etat).toBe("pause");
    expect(vus).toHaveLength(2);
    expect(vus[1]!.horodatage).not.toBe(vus[0]!.horodatage);
    expect(vus[1]!.signature).not.toBe(vus[0]!.signature);
    expect(vus[0]!.signature).toBe(signer("secret-de-test", vus[0]!.horodatage, "GET", `/api/executeur/v1/instances/${INSTANCE}/etat-voulu`, ""));
  });

  it("[A-285] une réponse hors contrat est une panne, jamais un état", async () => {
    const faux = (async () => new Response(JSON.stringify({ etat: "actif" }), { status: 200 })) as unknown as typeof fetch;
    const client = new ClientConsole({ url: "http://console.test", cle: "c4:auto-run-1:1", secret: () => "s", jeton: () => "j", fetch: faux, maintenant: () => 1_700_000_000, dormir: async () => undefined });
    await expect(client.lireEtatVoulu(INSTANCE)).rejects.toThrow();
  });
});
