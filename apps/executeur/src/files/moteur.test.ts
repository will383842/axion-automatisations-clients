import { randomUUID } from "node:crypto";
import { DelayedError, UnrecoverableError } from "bullmq";
import { deriverCleIntention } from "@axion-auto/contrats/src/c4/intention.ts";
import { defineAutomation } from "@axion-auto/sdk-module";
import { manifesteExemple } from "@axion-auto/sdk-module/exemples/module-exemple.ts";
import { describe, expect, it } from "vitest";
import { ConnecteurFactice, ConsoleFactice, HorlogeFactice, JournalEnMemoire, BoiteEnMemoire, Machine, type ContexteEtape } from "../noyau/index.ts";
import { ErreurConnecteur } from "../noyau/politique-erreurs.ts";
import { FauxMoteur } from "../noyau/postgres/faux-moteur.ts";
import { Cellule } from "./cellule.ts";
import { creerGestionnaire, executerAvecMoteur, mettreEnPauseAvecMoteur, type Travail } from "./travailleur.ts";

const CLIENT = randomUUID();
const INSTANCE = randomUUID();
const REGLAGES = { actionsAutomatiquesAutorisees: ["envoyer"], objetAccuse: "Accusé" };
const envoyer = async (ctx: ContexteEtape) => void (await ctx.effet("envoyer", "msg-1", {}));

function banc(corps: (ctx: ContexteEtape) => Promise<void> = envoyer, garantie: "idempotent_par_cle" | "verifiable_apres_coup" = "idempotent_par_cle") {
  const module = defineAutomation({ ...manifesteExemple, etapes: [{ nom: "e1", executer: corps }], connecteurs: [{ famille: "messagerie", actions: ["envoyer"], portees: ["envoi"], garantie }] });
  const moteur = new FauxMoteur();
  const horloge = new HorlogeFactice();
  const connecteur = new ConnecteurFactice();
  connecteur.dedupliquer = garantie === "idempotent_par_cle";
  const console = new ConsoleFactice({ reglages: REGLAGES });
  const executer = executerAvecMoteur({ pool: moteur.pool(), module, console, connecteurs: connecteur, horloge });
  const travail = (): Travail => {
    const id = randomUUID();
    moteur.ouvrirExecution(INSTANCE, id);
    return { id, instanceId: INSTANCE, clientId: CLIENT, palier: "pro" };
  };
  return { moteur, horloge, connecteur, console, executer, travail, module };
}

describe("Machine : un échec passager est reporté au travailleur, pas rejoué dedans", () => {
  it("[A-324] étape qui ne finit jamais : coupée à 120 s (delai_depasse, passagère), puis report sans nouvel essai interne", async () => {
    const h = new HorlogeFactice();
    const debut = h.maintenant();
    const module = defineAutomation({
      ...manifesteExemple,
      etapes: [{ nom: "e1", executer: () => new Promise<void>(() => undefined) }],
      connecteurs: [{ famille: "messagerie", actions: ["envoyer"], portees: ["envoi"], garantie: "idempotent_par_cle" }],
    });
    const ports = { journal: new JournalEnMemoire(), boite: new BoiteEnMemoire(), connecteurs: new ConnecteurFactice(), console: new ConsoleFactice({ reglages: REGLAGES }), horloge: h };
    const r = await h.piloter(new Machine({ module, ports, reporter: true }).lancer(INSTANCE, "exec-1"));
    expect(h.maintenant() - debut).toBeGreaterThanOrEqual(120_000);
    expect(h.maintenant() - debut).toBeLessThan(121_000);
    expect(r.statut).toBe("reportee");
    expect(r.cause).toMatchObject({ classe: "passagere", code: "delai_depasse" });
    expect(h.attentes).toEqual([]); // aucune attente de la politique dans la machine : le report appartient au travailleur
    expect(await ports.journal.lire(INSTANCE, "exec-1")).toEqual([]);
    expect(ports.console.evenements.map((e) => e.type)).toEqual(["debut"]); // ni « erreur » ni « fin » : rien n'est définitif
  });
});

describe("executerAvecMoteur avec un faux moteur", () => {
  it("[A-316] une exécution qui réussit : un envoi, intention faite, rien à relancer", async () => {
    const b = banc();
    await b.executer(b.travail());
    expect(b.connecteur.effetsReels).toBe(1);
    expect(b.moteur.etat.intentions.map((i) => i.etat)).toEqual(["faite"]);
  });

  it("[A-321] erreur passagère : relancée vers le travailleur telle quelle (une seule tentative dans la machine)", async () => {
    const b = banc();
    b.connecteur.programmer(new ErreurConnecteur("passagere", "reseau"));
    await expect(b.horloge.piloter(b.executer(b.travail()))).rejects.toMatchObject({ classe: "passagere", code: "reseau" });
    expect(b.connecteur.appels).toHaveLength(1);
    expect(b.horloge.attentes).toEqual([]);
  });

  it("[A-318] intention d'un autre processus encore dans sa fenêtre : report passager, ni vérification ni envoi", async () => {
    const autre = banc(envoyer, "verifiable_apres_coup");
    const t2 = autre.travail();
    const cle = deriverCleIntention({ instanceId: INSTANCE, executionId: t2.id, etape: "e1", action: "envoyer", element: "msg-1" });
    autre.moteur.etat.intentions.push({ cle, executionId: t2.id, garantie: "verifiable_apres_coup", etat: "ecrite", creeLe: autre.horloge.maintenant() });
    await expect(autre.executer(t2)).rejects.toMatchObject({ classe: "passagere", code: "intention_en_cours" });
    expect(autre.connecteur.appels).toEqual([]);
  });

  it("[A-316] la boîte est partagée par client dans le processus : un échec connu libère le bail, le nouvel essai ne reste pas bloqué", async () => {
    const b = banc();
    const t = b.travail();
    b.connecteur.programmer(new ErreurConnecteur("passagere", "reseau"));
    await expect(b.horloge.piloter(b.executer(t))).rejects.toBeInstanceOf(ErreurConnecteur);
    await b.horloge.piloter(b.executer(t)); // même client, même processus, tout de suite
    expect(b.connecteur.effetsReels).toBe(1);
    expect(b.moteur.etat.intentions.map((i) => i.etat)).toEqual(["faite"]);
  });

  it("[A-322] identification refusée : la machine met l'instance en pause, le travail se termine", async () => {
    const b = banc(async () => {
      throw new ErreurConnecteur("identification", "jeton_refuse");
    });
    await b.horloge.piloter(b.executer(b.travail()));
    expect(b.console.etat).toBe("pause");
  });

  it("[A-322] mettreEnPauseAvecMoteur appelle console.mettreEnPause de la branche", async () => {
    const b = banc();
    await mettreEnPauseAvecMoteur({ pool: b.moteur.pool(), module: b.module, console: b.console, connecteurs: b.connecteur, horloge: b.horloge })(INSTANCE);
    expect(b.console.etat).toBe("pause");
  });
});

describe("travailleur complet avec un faux moteur", () => {
  function monter(b: ReturnType<typeof banc>) {
    const semaphore = { acquerir: async () => true, prolonger: async () => true, liberer: async () => undefined, bailMs: 60_000 };
    const lire = (job: { data: Record<string, unknown> }) => job.data["travail"] as Travail;
    return creerGestionnaire({ delaiRemiseMs: 5_000 }, { cellule: new Cellule("c1", [INSTANCE]), semaphore: semaphore as never, executer: b.executer, mettreEnPause: mettreEnPauseAvecMoteur({ pool: b.moteur.pool(), module: b.module, console: b.console, connecteurs: b.connecteur, horloge: b.horloge }) }, lire, b.horloge);
  }
  function job(t: Travail) {
    const j = {
      data: { travail: t } as Record<string, unknown>,
      reports: [] as number[],
      async updateData(d: Record<string, unknown>) {
        j.data = d;
      },
      async moveToDelayed(q: number) {
        j.reports.push(q);
      },
    };
    return j;
  }

  it("[A-321] 5 essais passagers dans la vraie chaîne (gestionnaire + moteur) : 4 reports, puis abandon", async () => {
    const b = banc();
    b.connecteur.programmer(...Array.from({ length: 5 }, () => new ErreurConnecteur("passagere", "reseau")));
    const g = monter(b);
    const j = job(b.travail());
    for (let i = 0; i < 4; i++) await expect(b.horloge.piloter(g(j as never, "jeton"))).rejects.toBeInstanceOf(DelayedError);
    await expect(b.horloge.piloter(g(j as never, "jeton"))).rejects.toBeInstanceOf(UnrecoverableError);
    expect(j.reports).toHaveLength(4);
  });
});
