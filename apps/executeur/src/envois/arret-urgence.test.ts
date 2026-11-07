import { randomUUID } from "node:crypto";
import { DelayedError, UnrecoverableError } from "bullmq";
import { describe, expect, it } from "vitest";
import { defineAutomation } from "@axion-auto/sdk-module";
import { manifesteExemple } from "@axion-auto/sdk-module/exemples/module-exemple.ts";
import { Cellule } from "../files/cellule.ts";
import { creerGestionnaire, executerAvecMoteur, type Travail } from "../files/travailleur.ts";
import { HorlogeFactice } from "../noyau/horloge.ts";
import { ConnecteurFactice } from "../noyau/memoire/connecteur-factice.ts";
import { ConsoleFactice } from "../noyau/memoire/console-factice.ts";
import { FauxMoteur } from "../noyau/postgres/faux-moteur.ts";
import { CLE_ARRET_GLOBAL } from "./arret-urgence.ts";
import { garderConnecteurs } from "./garde-envoi.ts";

const CLIENT = randomUUID();
const INSTANCE = "inst-1";

class FauxValkey {
  cles = new Map<string, string>();
  async mget(...cles: string[]) {
    return cles.map((c) => this.cles.get(c) ?? null);
  }
  async call(_commande: string, cle = "", valeur = "", ...options: string[]): Promise<unknown> {
    const ancien = this.cles.get(cle) ?? null;
    if (options.includes("NX") && ancien !== null) return options.includes("GET") ? ancien : null;
    this.cles.set(cle, valeur);
    return options.includes("GET") ? ancien : "OK";
  }
}
class ConsoleClient extends ConsoleFactice {
  override async lireConfiguration(instanceId: string) {
    return { ...(await super.lireConfiguration(instanceId)), clientId: CLIENT };
  }
}

// Chaîne réelle : gestionnaire du travailleur, executerAvecMoteur, machine, garde ; base et Valkey simulés.
function banc(envois = 1) {
  const module = defineAutomation({
    ...manifesteExemple,
    etapes: [{ nom: "e1", executer: async (ctx) => { for (let i = 1; i <= envois; i++) await ctx.effet("envoyer", `msg-${i}`, { destinataire: "client@exemple.fr", objet: "x", corps: "y" }); } }],
    connecteurs: [{ famille: "messagerie", actions: ["envoyer"], portees: ["envoi"], garantie: "verifiable_apres_coup" }],
  });
  const moteur = new FauxMoteur();
  const horloge = new HorlogeFactice();
  const valkey = new FauxValkey();
  const connecteur = new ConnecteurFactice();
  connecteur.dedupliquer = false;
  const console = new ConsoleClient({ reglages: { actionsAutomatiquesAutorisees: ["envoyer"], objetAccuse: "x" } });
  const executer = executerAvecMoteur({
    pool: moteur.pool(), module, console, connecteurs: connecteur, horloge,
    garderEnvois: (c, ctx) => garderConnecteurs(c, { valkey, tenantId: ctx.clientId, instanceId: ctx.travail.instanceId, executionId: ctx.travail.id, annulable: ctx.travail.annulable === true, proprietaireJeton: { clientDuJeton: async () => CLIENT }, carnet: { connait: async () => true } }),
  });
  const semaphore = { acquerir: async () => true, prolonger: async () => true, liberer: async () => undefined, bailMs: 60_000 };
  const lire = (job: { data: Record<string, unknown> }) => job.data["travail"] as Travail;
  const gestionnaire = creerGestionnaire({ delaiRemiseMs: 5_000 }, { cellule: new Cellule("c1", [INSTANCE]), semaphore: semaphore as never, executer }, lire, horloge);
  const travail = (): Travail => {
    const id = randomUUID();
    moteur.ouvrirExecution(INSTANCE, id);
    return { id, instanceId: INSTANCE, clientId: CLIENT, palier: "pro" };
  };
  const job = (t: Travail) => {
    const j = {
      data: { travail: t } as Record<string, unknown>,
      reports: [] as number[],
      retires: 0,
      async updateData(d: Record<string, unknown>) { j.data = d; },
      async moveToDelayed(q: number) { j.reports.push(q); },
      async remove() { j.retires++; },
    };
    return j;
  };
  const lancer = (j: ReturnType<typeof job>) => horloge.piloter(gestionnaire(j as never, "jeton"));
  return { moteur, horloge, valkey, connecteur, console, travail, job, lancer };
}

describe("arrêt d'urgence rencontré par le travailleur", () => {
  it("[C-534] @envoi arrêt rencontré : travail marqué arrete, UnrecoverableError arret_urgence, jamais moveToDelayed, essais inchangés", async () => {
    const b = banc();
    b.valkey.cles.set(CLE_ARRET_GLOBAL, "1");
    const j = b.job(b.travail());
    await expect(b.lancer(j)).rejects.toThrow(new UnrecoverableError("arret_urgence"));
    expect(j.reports).toEqual([]);
    expect(j.data["essais"]).toBeUndefined();
    expect(j.data["arrete"]).toEqual({ code: "arret_urgence", a: new Date(b.horloge.maintenant()).toISOString() });
    expect(j.retires).toBe(0);
    expect(b.connecteur.appels).toHaveLength(0);
  });

  it("[C-534] @envoi arrêt rencontré : la machine n'inscrit pas echec au journal et ne publie aucun événement erreur", async () => {
    const b = banc();
    b.valkey.cles.set(CLE_ARRET_GLOBAL, "1");
    await expect(b.lancer(b.job(b.travail()))).rejects.toBeInstanceOf(UnrecoverableError);
    expect(b.moteur.etat.journal.filter((l) => l.cle.startsWith("echec"))).toEqual([]);
    expect(b.console.evenements.filter((e) => e.type === "erreur")).toEqual([]);
  });

  it("[C-534] @envoi arrêt levé puis relance explicite : le message part une fois ; relance d'un travail déjà parti : 0 renvoi", async () => {
    const b = banc();
    const j = b.job(b.travail());
    b.valkey.cles.set(CLE_ARRET_GLOBAL, "1");
    await expect(b.lancer(j)).rejects.toBeInstanceOf(UnrecoverableError);
    b.valkey.cles.delete(CLE_ARRET_GLOBAL); // geste explicite de la console
    await b.lancer(j); // relance explicite du même travail
    expect(b.connecteur.effetsReels).toBe(1);
    await b.lancer(j);
    expect(b.connecteur.effetsReels).toBe(1);
    expect(b.connecteur.appels).toHaveLength(1);
  });

  it("[C-534] @envoi arrêt posé pendant un appel en vol : au plus 1 effet (celui en vol), aucun renvoi ni après la levée ni après la relance explicite", async () => {
    const b = banc(2);
    const j = b.job(b.travail());
    b.connecteur.surAppel = async () => void b.valkey.cles.set(CLE_ARRET_GLOBAL, "1"); // posé pendant le 1er appel
    await expect(b.lancer(j)).rejects.toBeInstanceOf(UnrecoverableError);
    expect(b.connecteur.effetsReels).toBe(1);
    b.valkey.cles.delete(CLE_ARRET_GLOBAL);
    b.connecteur.surAppel = undefined;
    await b.lancer(j);
    expect(b.connecteur.effetsReels).toBe(2);
    expect(b.connecteur.appels.map((a) => a.cle)).toHaveLength(2);
    await b.lancer(j);
    expect(b.connecteur.effetsReels).toBe(2);
  });

  it("[C-534] @envoi levée de l'arrêt sans geste : aucun travail arrêté ne repart seul", async () => {
    const b = banc();
    const j = b.job(b.travail());
    b.valkey.cles.set(CLE_ARRET_GLOBAL, "1");
    await expect(b.lancer(j)).rejects.not.toBeInstanceOf(DelayedError);
    b.valkey.cles.delete(CLE_ARRET_GLOBAL);
    b.horloge.regler(b.horloge.maintenant() + 3_600_000);
    expect(j.reports).toEqual([]); // jamais remis en attente avec délai
    expect(b.connecteur.appels).toHaveLength(0);
  });

  it("[C-534] @envoi arrêt posé avec 20 envois en file : 0 appel de plus, 20 travaux présents et marqués arrete, délai mesuré inférieur à 60 s", async () => {
    const b = banc();
    const jobs = Array.from({ length: 20 }, () => b.job(b.travail()));
    const t0 = Date.now();
    b.valkey.cles.set(CLE_ARRET_GLOBAL, "1");
    for (const j of jobs) await expect(b.lancer(j)).rejects.toBeInstanceOf(UnrecoverableError);
    expect(Date.now() - t0).toBeLessThan(60_000);
    expect(b.connecteur.appels).toHaveLength(0);
    expect(jobs.filter((j) => (j.data["arrete"] as { code?: string } | undefined)?.code === "arret_urgence")).toHaveLength(20);
    expect(jobs.reduce((n, j) => n + j.retires, 0)).toBe(0);
  });
});
