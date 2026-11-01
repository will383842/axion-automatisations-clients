import { randomUUID } from "node:crypto";
import { deriverCleIntention } from "@axion-auto/contrats/src/c4/intention.ts";
import { defineAutomation, type Garantie } from "@axion-auto/sdk-module";
import { manifesteExemple } from "@axion-auto/sdk-module/exemples/module-exemple.ts";
import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { ConnecteurFactice, ConsoleFactice, CoupureProcessus, HorlogeFactice, Machine, type ContexteEtape } from "../index.ts";
import { BoitePostgres } from "./boite-envoi.ts";
import { CurseursPostgres } from "./curseurs.ts";
import { JournalPostgres } from "./journal-etapes.ts";

// Imitation minimale de la base moteur pour les tests ordinaires : les transactions sont copiées au BEGIN et reprises au COMMIT.
// Elle ne comprend que les requêtes des adaptateurs PostgreSQL (reconnues par leur début) ; la vraie base est essayée dans les *.int.test.ts.
interface Etat {
  executions: { id: string; instanceId: string; debut: Date }[];
  intentions: { cle: string; executionId: string; garantie: string; etat: string }[];
  journal: { executionId: string; etape: string; cle: string; statut: string; creeLe: Date }[];
  curseurs: { instanceId: string; declencheur: string; valeur: string }[];
}

class FauxMoteur {
  etat: Etat = { executions: [], intentions: [], journal: [], curseurs: [] };
  requetes: string[] = [];
  // Nombre de requêtes avant la mort du processus (undefined : jamais) ; les suivantes lèvent CoupureProcessus.
  mortApres: number | undefined;
  // Début de requête qui tue le processus (avant son effet).
  mortSur: string | undefined;
  #vues = 0;
  #horloge = 0;

  ouvrirExecution(instanceId: string, executionId: string) {
    this.etat.executions.push({ id: executionId, instanceId, debut: new Date(Date.UTC(2026, 10, 1)) });
  }
  // Un nouveau processus : le compteur repart, la base garde ce qui était validé.
  redemarrer(mortApres?: number) {
    this.#vues = 0;
    this.mortApres = mortApres;
  }
  get requetesVues() {
    return this.#vues;
  }

  pool(): Pool {
    return {
      connect: async () => {
        let copie: Etat | undefined;
        return {
          release: () => undefined,
          query: async (texte: string, params: unknown[] = []) => {
            const sql = texte.replace(/\s+/g, " ").trim();
            this.requetes.push(sql);
            if (this.mortSur && sql.startsWith(this.mortSur)) throw new CoupureProcessus();
            if (this.mortApres !== undefined && this.#vues >= this.mortApres) throw new CoupureProcessus();
            this.#vues++;
            if (sql === "BEGIN") {
              copie = structuredClone(this.etat);
              return { rows: [], rowCount: 0 };
            }
            if (sql === "COMMIT") {
              if (copie) this.etat = copie;
              copie = undefined;
              return { rows: [], rowCount: 0 };
            }
            if (sql === "ROLLBACK") {
              copie = undefined;
              return { rows: [], rowCount: 0 };
            }
            const e = copie ?? this.etat;
            return this.#executer(e, sql, params);
          },
        };
      },
    } as unknown as Pool;
  }

  #executer(e: Etat, sql: string, p: unknown[]): { rows: Record<string, unknown>[]; rowCount: number } {
    const rien = { rows: [], rowCount: 0 };
    if (sql.startsWith("SELECT set_config")) return rien;
    if (sql.startsWith("SELECT debut FROM executions")) {
      const x = e.executions.find((v) => v.id === p[1] && v.instanceId === p[2]);
      return x ? { rows: [{ debut: x.debut }], rowCount: 1 } : rien;
    }
    if (sql.startsWith("INSERT INTO intentions")) {
      if (e.intentions.some((v) => v.cle === p[3])) return rien;
      e.intentions.push({ cle: p[3] as string, executionId: p[1] as string, garantie: p[4] as string, etat: "ecrite" });
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("SELECT etat, garantie FROM intentions")) {
      const x = e.intentions.find((v) => v.cle === p[1]);
      return x ? { rows: [{ etat: x.etat, garantie: x.garantie, execution_id: x.executionId }], rowCount: 1 } : rien;
    }
    if (sql.startsWith("UPDATE intentions SET etat")) {
      const x = e.intentions.find((v) => v.cle === p[1] && v.etat === "ecrite");
      if (!x) return rien;
      x.etat = p[2] as string;
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("INSERT INTO journal_etape")) {
      if (e.journal.some((v) => v.executionId === p[1] && v.etape === p[3] && v.cle === p[4])) return rien;
      e.journal.push({ executionId: p[1] as string, etape: p[3] as string, cle: p[4] as string, statut: "en_cours", creeLe: new Date(Date.UTC(2026, 10, 1, 0, 0, this.#horloge++)) });
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE journal_etape SET statut")) {
      const x = e.journal.find((v) => v.executionId === p[1] && v.etape === p[2] && v.cle === p[3]);
      if (!x) return rien;
      x.statut = p[4] as string;
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("SELECT j.etape")) {
      const rows = e.journal.filter((v) => v.executionId === p[1]).map((v) => ({ etape: v.etape, cle: v.cle, statut: v.statut, cree_le: v.creeLe }));
      return { rows, rowCount: rows.length };
    }
    if (sql.startsWith("SELECT valeur FROM curseurs")) {
      const x = e.curseurs.find((v) => v.instanceId === p[1] && v.declencheur === p[2]);
      return x ? { rows: [{ valeur: x.valeur }], rowCount: 1 } : rien;
    }
    if (sql.startsWith("INSERT INTO curseurs")) {
      const x = e.curseurs.find((v) => v.instanceId === p[1] && v.declencheur === p[2]);
      if (x) x.valeur = p[3] as string;
      else e.curseurs.push({ instanceId: p[1] as string, declencheur: p[2] as string, valeur: p[3] as string });
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`requête inconnue du faux moteur : ${sql.slice(0, 80)}`);
  }
}


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
