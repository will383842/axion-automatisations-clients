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
    moteur.maintenant = horloge.maintenant();
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
    const { lancer } = b.processus();
    b.moteur.mortSur = "INSERT INTO intentions"; // redemarrer() ne remet que mortApres : mortSur s'arme après processus()
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

describe("deux travailleurs sur la même base (bail non partagé en base, ADR 0102)", () => {
  const cle = (b: ReturnType<typeof banc>) => deriverCleIntention({ instanceId: INSTANCE, executionId: b.executionId, etape: "e1", action: "envoyer", element: "msg-1" });
  const intention = (b: ReturnType<typeof banc>, action = "envoyer") => ({ cle: cle(b), instanceId: INSTANCE, executionId: b.executionId, etape: "e1", element: "msg-1", action, garantie: "idempotent_par_cle" as const });

  it("[A-318] @anti-doublon le 2e travailleur arrive pendant que le 1er envoie encore : intention récente = occupée, ni vérification ni second envoi", async () => {
    const b = banc({ e1: envoyer }, "verifiable_apres_coup");
    b.connecteur.dedupliquer = false;
    const premier = b.processus();
    const verifs: string[] = [];
    const verifier = b.connecteur.verifier.bind(b.connecteur);
    b.connecteur.verifier = async (a, k) => (verifs.push(k), verifier(a, k));
    let second: Awaited<ReturnType<typeof premier.lancer>> | undefined;
    b.connecteur.surAppel = async () => {
      // Le 1er est en plein envoi (intention écrite, pas faite) : un 2e processus reprend le même travail.
      b.connecteur.surAppel = undefined;
      second = await b.processus().lancer();
    };
    expect((await premier.lancer()).statut).toBe("terminee");
    expect(second).toEqual({ statut: "en_cours", etape: "e1" });
    expect(verifs).toEqual([]);
    expect(b.connecteur.appels).toHaveLength(1);
    expect(b.moteur.etat.intentions.map((i) => i.etat)).toEqual(["faite"]);
  });

  it("[A-318] @anti-doublon une intention plus vieille que le délai de l'étape + la marge n'est plus occupée : reprise par vérification", async () => {
    const b = banc({ e1: envoyer }, "verifiable_apres_coup");
    b.moteur.etat.intentions.push({ cle: cle(b), executionId: b.executionId, garantie: "verifiable_apres_coup", etat: "ecrite", creeLe: b.horloge.maintenant() - 181_000 });
    b.connecteur.verification = "trouvee";
    expect((await b.processus().lancer()).statut).toBe("terminee");
    expect(b.connecteur.appels).toEqual([]);
  });

  it("[A-318] la marge est configurable au constructeur (pour les tests) et part du délai de l'étape", async () => {
    const b = banc({ e1: envoyer }, "verifiable_apres_coup");
    const ecrire = (grace: number, age: number) => {
      b.moteur.etat.intentions = [{ cle: cle(b), executionId: b.executionId, garantie: "verifiable_apres_coup", etat: "ecrite", creeLe: b.horloge.maintenant() - age }];
      const maintenant = b.horloge.maintenant();
      return new BoitePostgres(b.moteur.pool(), TENANT, { graceMs: grace }).ecrire(intention(b), { proprietaire: "p", jusqua: maintenant + 120_000 + 60_000 }, maintenant);
    };
    expect((await ecrire(60_000, 150_000)).occupee).toBe(true); // 150 s < 120 s + 60 s
    expect((await ecrire(0, 150_000)).occupee).toBe(false); // 150 s > 120 s + 0
    expect((await ecrire(0, 100_000)).occupee).toBe(true);
  });

  it("[A-318] une intention créée par cet appel n'est jamais occupée ; une intention déjà faite non plus", async () => {
    const b = banc({ e1: envoyer });
    const boite = new BoitePostgres(b.moteur.pool(), TENANT);
    const bail = { proprietaire: "p", jusqua: b.horloge.maintenant() + 180_000 };
    expect(await boite.ecrire(intention(b), bail, b.horloge.maintenant())).toMatchObject({ creee: true, occupee: false });
    await boite.marquerFaite(cle(b), "p");
    expect(await new BoitePostgres(b.moteur.pool(), TENANT).ecrire(intention(b), bail, b.horloge.maintenant())).toMatchObject({ creee: false, occupee: false });
  });

  it("[A-312] lire() rend l'exécution de l'intention, même écrite par un autre processus", async () => {
    const b = banc({ e1: envoyer });
    await b.processus().lancer();
    const lue = await new BoitePostgres(b.moteur.pool(), TENANT).lire(cle(b));
    expect(lue).toMatchObject({ executionId: b.executionId, etat: "faite", garantie: "idempotent_par_cle", etape: "", action: "" });
  });

  it("[A-317] une même clé reprise avec une autre action garde l'action connue du processus", async () => {
    const b = banc({ e1: envoyer });
    const boite = new BoitePostgres(b.moteur.pool(), TENANT);
    const bail = { proprietaire: "p", jusqua: b.horloge.maintenant() + 180_000 };
    await boite.ecrire(intention(b), bail, b.horloge.maintenant());
    const r = await boite.ecrire(intention(b, "classer"), { ...bail, proprietaire: "q" }, b.horloge.maintenant());
    expect(r.intention.action).toBe("envoyer");
  });
});

describe("mémoire de la boîte partagée par client", () => {
  const cles = (b: ReturnType<typeof banc>, n: number) => Array.from({ length: n }, (_, i) => ({ cle: `cle-${i}`, instanceId: INSTANCE, executionId: b.executionId, etape: "e1", element: `msg-${i}`, action: "envoyer", garantie: "idempotent_par_cle" as const }));

  it("[A-316] une intention déjà « faite » en base n'est pas gardée en mémoire", async () => {
    const b = banc({ e1: envoyer });
    const boite = new BoitePostgres(b.moteur.pool(), TENANT);
    b.moteur.etat.intentions.push({ cle: "cle-0", executionId: b.executionId, garantie: "idempotent_par_cle", etat: "faite", creeLe: 0 });
    await boite.ecrire(cles(b, 1)[0]!, { proprietaire: "p", jusqua: b.horloge.maintenant() + 1_000 }, b.horloge.maintenant());
    expect(boite.tailles.connues).toBe(0);
    expect(boite.tailles.baux).toBe(0);
  });

  it("[A-316] les baux échus et les échecs connus anciens sont purgés : la mémoire ne grossit pas sans fin", async () => {
    const b = banc({ e1: envoyer });
    const boite = new BoitePostgres(b.moteur.pool(), TENANT);
    const t0 = b.horloge.maintenant();
    for (const [i, c] of cles(b, 20).entries()) {
      await boite.ecrire(c, { proprietaire: `p${i}`, jusqua: t0 + 1_000 }, t0);
      await boite.liberer(c.cle, `p${i}`);
    }
    expect(boite.tailles.rendues).toBe(20);
    const tard = t0 + 400_000;
    await boite.ecrire({ ...cles(b, 1)[0]!, cle: "cle-neuve", element: "msg-neuf" }, { proprietaire: "z", jusqua: tard + 1_000 }, tard);
    expect(boite.tailles.rendues).toBe(0);
    expect(boite.tailles.baux).toBe(1);
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
        let dernier = "aucune";
        for (let vie = 0; vie < 40; vie++) {
          const { lancer } = b.processus(vie < 5 ? Math.floor(alea() * 40) : undefined);
          try {
            const r = await lancer();
            dernier = r.statut;
            if (r.statut === "terminee" || r.statut === "a_trancher") break;
            apresMort(b); // en_cours : l'autre processus est tenu pour mort après la fenêtre
          } catch (e) {
            if (!(e instanceof CoupureProcessus)) throw e;
            dernier = "coupure";
            apresMort(b);
          }
        }
        expect(dernier, `garantie ${garantie}, tour ${tour} : la dernière vie doit finir`).toMatch(/^(terminee|a_trancher)$/);
        const appelsParCle = new Map<string, number>();
        for (const a of b.connecteur.appels) appelsParCle.set(a.cle, (appelsParCle.get(a.cle) ?? 0) + 1);
        for (const [etape, element, action] of [["e1", "msg-1", "envoyer"], ["e2", "msg-2", "classer"]] as const) {
          const cle = deriverCleIntention({ instanceId: INSTANCE, executionId: b.executionId, etape, action, element });
          const appels = appelsParCle.get(cle) ?? 0;
          // Au plus un effet par clé : un connecteur qui dédoublonne par clé peut être rappelé, les autres jamais.
          const effets = garantie === "idempotent_par_cle" ? Math.min(appels, 1) : appels;
          expect(effets, `${garantie} ${etape} : effets`).toBeLessThanOrEqual(1);
          const etat = b.moteur.etat.intentions.find((i) => i.cle === cle)?.etat;
          // Une clé jamais appelée ne peut pas être « faite » : elle est à trancher (ou son étape n'a pas été atteinte).
          if (appels === 0 && etat !== undefined) expect(etat, `${garantie} ${etape} jamais appelée`).toBe("a_trancher");
          if (dernier === "terminee") expect(etat).toBe("faite");
        }
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
