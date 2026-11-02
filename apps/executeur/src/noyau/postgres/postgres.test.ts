import { randomUUID } from "node:crypto";
import { deriverCleIntention } from "@axion-auto/contrats/src/c4/intention.ts";
import { defineAutomation, type Garantie } from "@axion-auto/sdk-module";
import { manifesteExemple } from "@axion-auto/sdk-module/exemples/module-exemple.ts";
import { describe, expect, it } from "vitest";
import { ConnecteurFactice, ConsoleFactice, CoupureProcessus, HorlogeFactice, Machine, type ContexteEtape } from "../index.ts";
import { BoitePostgres } from "./boite-envoi.ts";
import { CurseursPostgres } from "./curseurs.ts";
import { FauxMoteur } from "./faux-moteur.ts";
import { JournalPostgres } from "./journal-etapes.ts";

const TENANT = randomUUID();
const INSTANCE = randomUUID();
const REGLAGES = { actionsAutomatiquesAutorisees: ["envoyer", "classer"], objetAccuse: "Accusé" };
type Corps = (ctx: ContexteEtape) => Promise<void>;

function banc(corps: Record<string, Corps>, garantie: Garantie = "idempotent_par_cle") {
  const module = defineAutomation({
    ...manifesteExemple,
    etapes: Object.entries(corps).map(([nom, executer]) => ({ nom, executer })),
    connecteurs: [{ famille: "messagerie", actions: ["envoyer", "classer"], portees: ["envoi"], garantie }],
  });
  const moteur = new FauxMoteur();
  const executionId = randomUUID();
  moteur.ouvrirExecution(INSTANCE, executionId);
  const horloge = new HorlogeFactice();
  const connecteur = new ConnecteurFactice();
  connecteur.dedupliquer = garantie === "idempotent_par_cle";
  const console = new ConsoleFactice({ reglages: REGLAGES });
  // Un « processus » = de nouveaux adaptateurs sur la même base : rien ne reste en mémoire d'un processus à l'autre.
  const processus = (mortApres?: number) => {
    moteur.redemarrer(mortApres);
    const pool = moteur.pool();
    const ports = { journal: new JournalPostgres(pool, TENANT), boite: new BoitePostgres(pool, TENANT), connecteurs: connecteur, console, horloge };
    return { ports, lancer: () => horloge.piloter(new Machine({ module, ports }).lancer(INSTANCE, executionId)) };
  };
  return { moteur, executionId, horloge, connecteur, console, processus };
}
const envoyer: Corps = async (ctx) => void (await ctx.effet("envoyer", "msg-1", { objet: "x" }));
const apresMort = (b: ReturnType<typeof banc>) => b.horloge.regler(b.horloge.maintenant() + 181_000);

describe("journal des étapes sur PostgreSQL", () => {
  it("[A-315] l'exécution reprend à l'étape interrompue (journal relu en base)", async () => {
    const vues: string[] = [];
    let coupe = true;
    const b = banc({
      e1: async () => void vues.push("e1"),
      e2: async () => void vues.push("e2"),
      e3: async () => {
        if (coupe) {
          coupe = false;
          throw new CoupureProcessus();
        }
        vues.push("e3");
      },
    });
    const { ports, lancer } = b.processus();
    await expect(lancer()).rejects.toBeInstanceOf(CoupureProcessus);
    const lues = await ports.journal.lire(INSTANCE, b.executionId);
    expect(lues.map((e) => [e.etape, e.statut])).toEqual([["e1", "faite"], ["e2", "faite"]]);
    vues.length = 0;
    expect((await b.processus().lancer()).statut).toBe("terminee");
    expect(vues).toEqual(["e3"]);
  });

  it("[A-286] le journal garde l'essai et l'heure, jamais de texte libre", async () => {
    const b = banc({ e1: async () => undefined });
    const { ports } = b.processus();
    await ports.journal.inscrire({ instanceId: INSTANCE, executionId: b.executionId, etape: "e1", statut: "echec", essai: 3, a: "2026-11-01T00:00:00.000Z" });
    const [entree] = await ports.journal.lire(INSTANCE, b.executionId);
    expect(Object.keys(entree!).sort()).toEqual(["a", "essai", "etape", "executionId", "instanceId", "statut"]);
    expect(entree).toMatchObject({ statut: "echec", essai: 3 });
    expect(JSON.stringify(b.moteur.requetes)).not.toMatch(/message|texte|corps/i);
  });

  it("[A-312] une exécution inconnue du moteur est refusée avant toute écriture", async () => {
    const b = banc({ e1: async () => undefined });
    const { ports } = b.processus();
    await expect(ports.journal.inscrire({ instanceId: INSTANCE, executionId: randomUUID(), etape: "e1", statut: "faite", essai: 1, a: "2026-11-01T00:00:00.000Z" })).rejects.toThrow();
    expect(b.moteur.etat.journal).toEqual([]);
  });
});

describe("boîte d'envoi sur PostgreSQL", () => {
  it("[A-316] @anti-doublon l'intention est validée (COMMIT) avant l'appel du connecteur", async () => {
    const b = banc({ e1: envoyer });
    const { lancer } = b.processus();
    let vue: string | undefined;
    b.connecteur.surAppel = async (cle) => {
      const dernierCommit = b.moteur.requetes.lastIndexOf("COMMIT");
      const insertion = b.moteur.requetes.findIndex((r) => r.startsWith("INSERT INTO intentions"));
      expect(insertion).toBeGreaterThanOrEqual(0);
      expect(dernierCommit).toBeGreaterThan(insertion);
      vue = b.moteur.etat.intentions.find((i) => i.cle === cle)?.etat;
    };
    expect((await lancer()).statut).toBe("terminee");
    expect(vue).toBe("ecrite");
    expect(b.moteur.etat.intentions.map((i) => i.etat)).toEqual(["faite"]);
  });

  it("[A-316] @anti-doublon une transaction d'intention qui échoue : le connecteur n'est jamais appelé", async () => {
    const b = banc({ e1: envoyer });
    b.moteur.mortSur = "INSERT INTO intentions";
    const { lancer } = b.processus();
    b.moteur.mortSur = "INSERT INTO intentions"; // processus() remet le faux à neuf : la mort est réarmée
    await expect(lancer()).rejects.toBeInstanceOf(CoupureProcessus);
    expect(b.connecteur.appels).toEqual([]);
    expect(b.moteur.etat.intentions).toEqual([]);
  });

  it("[A-318] @anti-doublon intention écrite sans issue + message trouvé après coup → faite, sans renvoi", async () => {
    const b = banc({ e1: envoyer }, "verifiable_apres_coup");
    b.connecteur.dedupliquer = false;
    b.moteur.redemarrer();
    const cle = deriverCleIntention({ instanceId: INSTANCE, executionId: b.executionId, etape: "e1", action: "envoyer", element: "msg-1" });
    b.moteur.etat.intentions.push({ cle, executionId: b.executionId, garantie: "verifiable_apres_coup", etat: "ecrite" });
    b.connecteur.verification = "trouvee";
    expect((await b.processus().lancer()).statut).toBe("terminee");
    expect(b.connecteur.appels).toEqual([]);
    expect(b.moteur.etat.intentions[0]?.etat).toBe("faite");
  });

  it("[A-319] @anti-doublon intention écrite sans issue + garantie au_plus_une_fois → a_trancher, aucune nouvelle tentative", async () => {
    const b = banc({ e1: envoyer }, "au_plus_une_fois");
    const cle = deriverCleIntention({ instanceId: INSTANCE, executionId: b.executionId, etape: "e1", action: "envoyer", element: "msg-1" });
    b.moteur.etat.intentions.push({ cle, executionId: b.executionId, garantie: "au_plus_une_fois", etat: "ecrite" });
    const r = await b.processus().lancer();
    expect(r).toEqual({ statut: "a_trancher", etape: "e1" });
    expect(b.connecteur.appels).toEqual([]);
    expect(b.moteur.etat.intentions[0]?.etat).toBe("a_trancher");
    expect((await b.processus().lancer()).statut).toBe("a_trancher");
    expect(b.connecteur.appels).toEqual([]);
  });

  it("[A-317] la même clé d'intention n'est écrite qu'une fois : deux lancements, un seul effet", async () => {
    const b = banc({ e1: envoyer });
    await b.processus().lancer();
    await b.processus().lancer();
    expect(b.connecteur.effetsReels).toBe(1);
    expect(b.moteur.etat.intentions).toHaveLength(1);
  });
});

describe("arrêt brutal simulé", () => {
  it("[C-470] @anti-doublon arrêt brutal tiré au sort 50 fois : aucun message en double", async () => {
    let graine = 470;
    const alea = () => (graine = (graine * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648;
    for (const garantie of ["idempotent_par_cle", "verifiable_apres_coup", "au_plus_une_fois"] as const) {
      for (let tour = 0; tour < 17; tour++) {
        const b = banc({ e1: envoyer, e2: async (ctx) => void (await ctx.effet("classer", "msg-2", {})) }, garantie);
        // Le processus meurt après un nombre tiré au sort de requêtes, puis un autre le remplace, autant de fois qu'il faut.
        for (let vie = 0; vie < 40; vie++) {
          const { lancer } = b.processus(vie < 5 ? Math.floor(alea() * 40) : undefined);
          try {
            const r = await lancer();
            if (r.statut === "terminee" || r.statut === "a_trancher") break;
          } catch (e) {
            if (!(e instanceof CoupureProcessus)) throw e;
            apresMort(b);
          }
        }
        const parCle = new Map<string, number>();
        for (const a of b.connecteur.appels) parCle.set(a.cle, (parCle.get(a.cle) ?? 0) + 1);
        if (garantie === "idempotent_par_cle") expect(b.connecteur.effetsReels).toBeLessThanOrEqual(2);
        else for (const [, n] of parCle) expect(n).toBe(1);
        for (const i of b.moteur.etat.intentions) expect(["faite", "a_trancher", "ecrite"]).toContain(i.etat);
      }
    }
  });
});

describe("curseurs sur PostgreSQL", () => {
  it("[A-374] un curseur écrit est relu tel quel, par instance et par déclencheur", async () => {
    const b = banc({ e1: async () => undefined });
    const curseurs = new CurseursPostgres(b.moteur.pool(), TENANT);
    expect(await curseurs.lire(INSTANCE, "courrier")).toBeUndefined();
    await curseurs.ecrire(INSTANCE, "courrier", "uid-42");
    await curseurs.ecrire(INSTANCE, "courrier", "uid-43");
    expect(await curseurs.lire(INSTANCE, "courrier")).toBe("uid-43");
    expect(await curseurs.lire(INSTANCE, "autre")).toBeUndefined();
  });

  it("[A-374] une valeur de plus de 512 caractères est refusée avant la base", async () => {
    const b = banc({ e1: async () => undefined });
    const curseurs = new CurseursPostgres(b.moteur.pool(), TENANT);
    await expect(curseurs.ecrire(INSTANCE, "courrier", "x".repeat(513))).rejects.toThrow();
    expect(b.moteur.requetes).toEqual([]);
  });
});
