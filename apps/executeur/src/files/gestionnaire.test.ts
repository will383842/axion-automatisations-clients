import { DelayedError, UnrecoverableError } from "bullmq";
import { describe, expect, it } from "vitest";
import { Cellule } from "./cellule.ts";
import { ErreurConnecteur } from "../noyau/politique-erreurs.ts";
import { CoupureProcessus } from "../noyau/ports.ts";
import { HorlogeFactice } from "../noyau/horloge.ts";
import { BacFerme, creerGestionnaire, RemiseIntention, type Dependances, type Travail } from "./travailleur.ts";

// Faux travail BullMQ : seules les méthodes que le gestionnaire touche. « moveToDelayed » ne fait PAS monter attemptsMade (skipAttempt) : c'est tout l'enjeu.
function fauxJob(data: Record<string, unknown> = {}) {
  const j = {
    data: { instanceId: "inst-1", clientId: "cli-1", palier: "pro", ...data } as Record<string, unknown>,
    attemptsMade: 0,
    reports: [] as number[],
    async updateData(d: Record<string, unknown>) {
      j.data = d;
    },
    async moveToDelayed(quand: number) {
      j.reports.push(quand);
    },
  };
  return j;
}
const lire = (job: { data: Record<string, unknown> }): Travail => ({ id: "exec-1", instanceId: job.data["instanceId"] as string, clientId: "cli-1", palier: "pro" });
function deps(executer: () => Promise<void>, extra: Partial<Dependances> = {}): Omit<Dependances, "delaiRemiseMs"> {
  const semaphore = { acquerir: async () => true, prolonger: async () => true, liberer: async () => undefined, bailMs: 60_000 };
  return { cellule: new Cellule("c1", ["inst-1"]), semaphore: semaphore as never, executer, ...extra };
}
const gerer = (executer: () => Promise<void>, extra: Partial<Dependances> = {}) => creerGestionnaire({ delaiRemiseMs: 5_000 }, deps(executer, extra), lire, new HorlogeFactice());
const appeler = (g: ReturnType<typeof gerer>, j: ReturnType<typeof fauxJob>) => g(j as never, "jeton");

describe("gestionnaire du Worker : plafond de 5 essais compté dans les données du travail", () => {
  it("[A-321] le 5e essai d'une erreur passagère abandonne (UnrecoverableError), les quatre premiers reportent", async () => {
    const g = gerer(async () => {
      throw new ErreurConnecteur("passagere", "reseau");
    });
    const j = fauxJob();
    for (let essai = 1; essai <= 4; essai++) {
      await expect(appeler(g, j)).rejects.toBeInstanceOf(DelayedError);
      expect(j.data["essais"]).toBe(essai);
    }
    expect(j.reports).toHaveLength(4);
    await expect(appeler(g, j)).rejects.toBeInstanceOf(UnrecoverableError);
    expect(j.reports).toHaveLength(4);
  });

  it("[A-321] attemptsMade ne sert pas au compte : il reste à 0 et le plafond tient quand même", async () => {
    const g = gerer(async () => {
      throw new ErreurConnecteur("passagere", "reseau");
    });
    const j = fauxJob({ essais: 4 });
    expect(j.attemptsMade).toBe(0);
    await expect(appeler(g, j)).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it("[A-321] une remise faute de place ne consomme aucun essai", async () => {
    const g = creerGestionnaire({ delaiRemiseMs: 5_000 }, { ...deps(async () => undefined), semaphore: { acquerir: async () => false, prolonger: async () => true, liberer: async () => undefined, bailMs: 1 } as never }, lire, new HorlogeFactice());
    const j = fauxJob();
    await expect(appeler(g, j)).rejects.toBeInstanceOf(DelayedError);
    expect(j.data["essais"]).toBeUndefined();
  });
});

describe("gestionnaire du Worker : seule une erreur définitive d'un connecteur abandonne", () => {
  const passageres: [string, () => unknown][] = [
    ["base injoignable (08006)", () => Object.assign(new Error("connexion perdue"), { code: "08006" })],
    ["connexion refusée par la base (08001)", () => Object.assign(new Error("x"), { code: "08001" })],
    ["PgBouncer redémarre (57P01)", () => Object.assign(new Error("arrêt administrateur"), { code: "57P01" })],
    ["base qui démarre (57P03)", () => Object.assign(new Error("x"), { code: "57P03" })],
    ["sérialisation (40001)", () => Object.assign(new Error("x"), { code: "40001" })],
    ["verrou mortel (40P01)", () => Object.assign(new Error("x"), { code: "40P01" })],
    ["coupure du processus", () => new CoupureProcessus()],
    ["réseau coupé (ECONNRESET)", () => Object.assign(new Error("x"), { code: "ECONNRESET" })],
    ["réseau refusé (ECONNREFUSED)", () => Object.assign(new Error("Redis"), { code: "ECONNREFUSED" })],
    ["erreur inattendue sans code", () => new Error("texte libre")],
  ];
  it.each(passageres)("[A-320] %s : report, jamais d'abandon", async (_nom, fabriquer) => {
    const g = gerer(async () => {
      throw fabriquer();
    });
    const j = fauxJob();
    await expect(appeler(g, j)).rejects.toBeInstanceOf(DelayedError);
    expect(j.reports).toHaveLength(1);
    expect(j.data["essais"]).toBe(1);
  });

  it("[A-320] une ErreurConnecteur définitive abandonne tout de suite, sans report", async () => {
    const g = gerer(async () => {
      throw new ErreurConnecteur("definitive", "action_non_autorisee");
    });
    const j = fauxJob();
    await expect(appeler(g, j)).rejects.toBeInstanceOf(UnrecoverableError);
    expect(j.reports).toEqual([]);
  });

  it("[A-320] l'interrupteur du bac fermé abandonne (rien ne s'exécute, rien n'est rejoué)", async () => {
    const g = gerer(async () => {
      throw new BacFerme();
    });
    await expect(appeler(g, fauxJob())).rejects.toBeInstanceOf(UnrecoverableError);
  });
});

describe("gestionnaire du Worker : erreur d'identification", () => {
  it("[A-322] met l'instance en pause (console.mettreEnPause) et ne reporte pas", async () => {
    const pauses: string[] = [];
    const g = gerer(
      async () => {
        throw new ErreurConnecteur("identification", "jeton_refuse");
      },
      { mettreEnPause: async (id) => void pauses.push(id) },
    );
    const j = fauxJob();
    await appeler(g, j);
    expect(pauses).toEqual(["inst-1"]);
    expect(j.reports).toEqual([]);
  });

  it("[A-322] sans moyen de mettre en pause, le travail n'est pas perdu en silence : abandon explicite", async () => {
    const g = gerer(async () => {
      throw new ErreurConnecteur("identification", "jeton_refuse");
    });
    await expect(appeler(g, fauxJob())).rejects.toBeInstanceOf(UnrecoverableError);
  });
});

describe("gestionnaire du Worker : une intention occupée est une remise, pas un essai", () => {
  const FENETRE_MS = 150_000;
  const occupee = (h: HorlogeFactice) => async () => {
    throw new RemiseIntention(h.maintenant() + FENETRE_MS, "e1");
  };

  it("[A-318] intention_en_cours reçue trois fois : remise à chaque fois, essais intact, délai au moins égal à la fenêtre", async () => {
    const h = new HorlogeFactice();
    const g = creerGestionnaire({ delaiRemiseMs: 5_000 }, deps(occupee(h)), lire, h);
    const j = fauxJob();
    for (let i = 1; i <= 3; i++) {
      await expect(appeler(g, j)).rejects.toBeInstanceOf(DelayedError);
      expect(j.data["essais"]).toBeUndefined();
      expect(j.data["remises"]).toBe(i);
    }
    for (const quand of j.reports) expect(quand - Date.now()).toBeGreaterThanOrEqual(FENETRE_MS - 1_000);
  });

  it("[A-318] au-delà de 3 fenêtres : escalade tracée (à trancher), jamais d'abandon silencieux ni d'essais épuisés", async () => {
    const h = new HorlogeFactice();
    const escalades: unknown[][] = [];
    const g = creerGestionnaire({ delaiRemiseMs: 5_000 }, deps(occupee(h), { escalader: async (...a: unknown[]) => void escalades.push(a) } as never), lire, h);
    const j = fauxJob({ remises: 3 });
    await appeler(g, j); // ne lève pas : le travail est rendu à l'équipe, pas perdu
    expect(escalades).toEqual([[expect.objectContaining({ instanceId: "inst-1" }), "e1", "intention_en_cours_sans_issue"]]);
    expect(j.data["essais"]).toBeUndefined();
    expect(j.reports).toHaveLength(0);
  });

  it("[A-318] sans escalade branchée, le sens sûr reste un abandon explicite, jamais un second envoi", async () => {
    const h = new HorlogeFactice();
    const g = creerGestionnaire({ delaiRemiseMs: 5_000 }, deps(occupee(h)), lire, h);
    await expect(appeler(g, fauxJob({ remises: 3 }))).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it("[A-318] une remise ne remet pas à zéro le compte des essais déjà faits", async () => {
    const h = new HorlogeFactice();
    const g = creerGestionnaire({ delaiRemiseMs: 5_000 }, deps(occupee(h)), lire, h);
    const j = fauxJob({ essais: 2 });
    await expect(appeler(g, j)).rejects.toBeInstanceOf(DelayedError);
    expect(j.data["essais"]).toBe(2);
  });
});

describe("gestionnaire du Worker : la borne de 3 remises s'applique par occupation", () => {
  const FENETRE_MS = 150_000;
  // Scénario : chaque lancement lève une remise pour (etape, cle) ou réussit.
  type Pas = { etape: string; cle: string } | "reussit" | "echoue";
  const rejouer = (pas: Pas[], extra: Partial<Dependances> = {}) => {
    const h = new HorlogeFactice();
    let i = 0;
    const executer = async () => {
      const p = pas[i++]!;
      if (p === "reussit") return;
      if (p === "echoue") throw new ErreurConnecteur("passagere", "reseau");
      throw new RemiseIntention(h.maintenant() + FENETRE_MS, p.etape, p.cle);
    };
    return { g: creerGestionnaire({ delaiRemiseMs: 5_000 }, deps(executer, extra), lire, h), j: fauxJob() };
  };

  it("[A-318] 4 occupations successives sur des étapes ou clés différentes, résolues chacune : aucune escalade", async () => {
    const escalades: unknown[] = [];
    const occupations = [
      { etape: "e1", cle: "k1" },
      { etape: "e2", cle: "k2" },
      { etape: "e2", cle: "k3" },
      { etape: "e3", cle: "k4" },
    ];
    const { g, j } = rejouer(occupations.flatMap((o) => [o, "reussit" as const]), { escalader: async (...a: unknown[]) => void escalades.push(a) } as never);
    for (let i = 0; i < occupations.length; i++) {
      await expect(appeler(g, j)).rejects.toBeInstanceOf(DelayedError); // remise sur l'occupation i
      await appeler(g, j); // résolue : le lancement suivant réussit
    }
    expect(escalades).toEqual([]);
  });

  it("[A-318] quatre remises sur quatre clés différentes à la suite : le compte repart à 1 à chaque nouvelle clé", async () => {
    const escalades: unknown[] = [];
    const { g, j } = rejouer(["k1", "k2", "k3", "k4"].map((cle) => ({ etape: "e1", cle })), { escalader: async (...a: unknown[]) => void escalades.push(a) } as never);
    for (let i = 0; i < 4; i++) {
      await expect(appeler(g, j)).rejects.toBeInstanceOf(DelayedError);
      expect((j.data["remise"] as { n: number }).n).toBe(1);
    }
    expect(escalades).toEqual([]);
  });

  it("[A-318] une erreur passagère entre deux occupations remet aussi le compte à zéro", async () => {
    const { g, j } = rejouer([{ etape: "e1", cle: "k1" }, "echoue", { etape: "e1", cle: "k1" }]);
    await expect(appeler(g, j)).rejects.toBeInstanceOf(DelayedError);
    await expect(appeler(g, j)).rejects.toBeInstanceOf(DelayedError); // report d'une erreur passagère
    expect(j.data["remise"]).toBeUndefined();
    await expect(appeler(g, j)).rejects.toBeInstanceOf(DelayedError);
    expect((j.data["remise"] as { n: number }).n).toBe(1);
  });

  it("[A-318] 3 remises sur la MÊME occupation puis escalade tracée", async () => {
    const escalades: unknown[][] = [];
    const occupee = { etape: "e1", cle: "k1" };
    const { g, j } = rejouer([occupee, occupee, occupee, occupee], { escalader: async (...a: unknown[]) => void escalades.push(a) } as never);
    for (let n = 1; n <= 3; n++) {
      await expect(appeler(g, j)).rejects.toBeInstanceOf(DelayedError);
      expect(j.data["remise"]).toMatchObject({ etape: "e1", cle: "k1", n });
    }
    await appeler(g, j); // 4e fois sur la même occupation : escalade, sans lever
    expect(escalades).toEqual([[expect.objectContaining({ instanceId: "inst-1" }), "e1", "intention_en_cours_sans_issue"]]);
  });
});
