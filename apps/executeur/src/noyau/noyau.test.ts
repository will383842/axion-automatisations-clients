import { describe, expect, it } from "vitest";
import { deriverCleIntention } from "@axion-auto/contrats/src/c4/intention.ts";
import { CLES_CONTEXTE, defineAutomation, type Garantie } from "@axion-auto/sdk-module";
import { manifesteExemple } from "@axion-auto/sdk-module/exemples/module-exemple.ts";
import {
  BoiteEnMemoire,
  ConnecteurFactice,
  ConsoleFactice,
  CoupureProcessus,
  ErreurConnecteur,
  HorlogeFactice,
  JournalEnMemoire,
  Machine,
  type ContexteEtape,
} from "./index.ts";

const REGLAGES = { actionsAutomatiquesAutorisees: ["envoyer", "classer"], objetAccuse: "Accusé" };
type Corps = (ctx: ContexteEtape) => Promise<void>;
const envoyer: Corps = async (ctx) => {
  await ctx.effet("envoyer", "msg-1", { objet: "x" });
};

function banc(corps: Record<string, Corps>, garantie: Garantie = "idempotent_par_cle", o: { delai?: number; reglages?: Record<string, unknown> } = {}) {
  const module = defineAutomation({
    ...manifesteExemple,
    etapes: Object.entries(corps).map(([nom, executer]) => ({ nom, executer, ...(o.delai ? { delaiMaxSecondes: o.delai } : {}) })),
    connecteurs: [{ famille: "messagerie", actions: ["envoyer", "classer"], portees: ["envoi"], garantie }],
  });
  const horloge = new HorlogeFactice();
  const journal = new JournalEnMemoire();
  const boite = new BoiteEnMemoire();
  const connecteur = new ConnecteurFactice();
  const console = new ConsoleFactice({ reglages: o.reglages ?? REGLAGES });
  connecteur.dedupliquer = garantie === "idempotent_par_cle";
  const machine = new Machine({ module, ports: { journal, boite, connecteurs: connecteur, console, horloge } });
  const lancer = (executionId = "exec-1") => horloge.piloter(machine.lancer("inst-1", executionId));
  return { horloge, journal, boite, connecteur, console, machine, lancer };
}

// Simule un arrêt brutal juste après l'appel du connecteur, avant la marque « faite ».
function couperUneFois(b: ReturnType<typeof banc>) {
  const marquer = b.boite.marquerFaite.bind(b.boite);
  let vivant = true;
  b.boite.marquerFaite = async (cle, proprietaire) => {
    if (!vivant) return marquer(cle, proprietaire);
    vivant = false;
    throw new CoupureProcessus();
  };
}

// Un processus mort laisse son bail : la reprise attend qu'il expire (fin de l'étape + marge de 60 s).
const apresCoupure = (b: ReturnType<typeof banc>) => b.horloge.regler(b.horloge.maintenant() + 181_000);

describe("reprise", () => {
  it("[A-315] une exécution coupée après l'étape 2 reprend à l'étape 3", async () => {
    const vues: string[] = [];
    let coupure = true;
    const b = banc({
      e1: async () => void vues.push("e1"),
      e2: async () => void vues.push("e2"),
      e3: async () => {
        if (coupure) throw new CoupureProcessus();
        vues.push("e3");
      },
    });
    await expect(b.lancer()).rejects.toBeInstanceOf(CoupureProcessus);
    apresCoupure(b);
    coupure = false;
    expect((await b.lancer()).statut).toBe("terminee");
    expect(vues).toEqual(["e1", "e2", "e3"]);
  });

  it("[A-315] le module exemple du SDK tourne de bout en bout en mémoire", async () => {
    const horloge = new HorlogeFactice();
    const console = new ConsoleFactice({ reglages: { actionsAutomatiquesAutorisees: [], objetAccuse: "Accusé" } });
    let objet = "";
    const machine = new Machine({
      module: defineAutomation({ ...manifesteExemple, etapes: [{ nom: "accuser", executer: async (ctx) => void (objet = String(ctx.reglages.objetAccuse)) }] }),
      ports: { journal: new JournalEnMemoire(), boite: new BoiteEnMemoire(), connecteurs: new ConnecteurFactice(), console, horloge },
    });
    expect((await horloge.piloter(machine.lancer("inst-1", "exec-1"))).statut).toBe("terminee");
    expect(objet).toBe("Accusé");
    expect(console.evenements.map((e) => e.type)).toEqual(["debut", "fin"]);
  });
});

describe("anti-doublon", () => {
  it("[A-316] @anti-doublon aucune action n'est appelée sans intention écrite avant", async () => {
    const b = banc({ e1: envoyer });
    b.connecteur.surAppel = async (cle) => void expect((await b.boite.lire(cle))?.etat).toBe("ecrite");
    await b.lancer();
    expect(b.connecteur.appels).toHaveLength(1);
    const c = banc({ e1: envoyer });
    c.boite.ecrire = async () => {
      throw new CoupureProcessus();
    };
    await expect(c.lancer()).rejects.toBeInstanceOf(CoupureProcessus);
    expect(c.connecteur.appels).toHaveLength(0);
  });

  it("[A-317] @anti-doublon garantie idempotent_par_cle : le nouvel essai réutilise la même clé", async () => {
    const b = banc({ e1: envoyer }, "idempotent_par_cle");
    couperUneFois(b);
    await expect(b.lancer()).rejects.toBeInstanceOf(CoupureProcessus);
    apresCoupure(b);
    expect((await b.lancer()).statut).toBe("terminee");
    expect(b.connecteur.appels).toHaveLength(2);
    expect(b.connecteur.appels[1]?.cle).toBe(b.connecteur.appels[0]?.cle);
    expect(b.connecteur.effetsReels).toBe(1);
  });

  it("[A-318] @anti-doublon garantie verifiable_apres_coup : l'action trouvée sur l'outil n'est pas refaite", async () => {
    const b = banc({ e1: envoyer }, "verifiable_apres_coup");
    couperUneFois(b);
    await expect(b.lancer()).rejects.toBeInstanceOf(CoupureProcessus);
    apresCoupure(b);
    expect((await b.lancer()).statut).toBe("terminee");
    expect(b.connecteur.appels).toHaveLength(1);
    expect(b.connecteur.effetsReels).toBe(1);
  });

  it("[A-318] @anti-doublon verifiable_apres_coup : réponse « inconnue » de l'outil → à trancher, jamais de renvoi", async () => {
    const b = banc({ e1: envoyer }, "verifiable_apres_coup");
    b.connecteur.verification = "inconnue";
    couperUneFois(b);
    await expect(b.lancer()).rejects.toBeInstanceOf(CoupureProcessus);
    apresCoupure(b);
    expect((await b.lancer()).statut).toBe("a_trancher");
    expect(b.connecteur.appels).toHaveLength(1);
  });

  it("[A-319] @anti-doublon garantie au_plus_une_fois : aucune nouvelle tentative, cas « à trancher »", async () => {
    const b = banc({ e1: envoyer }, "au_plus_une_fois");
    couperUneFois(b);
    await expect(b.lancer()).rejects.toBeInstanceOf(CoupureProcessus);
    apresCoupure(b);
    expect((await b.lancer()).statut).toBe("a_trancher");
    expect(b.connecteur.appels).toHaveLength(1);
    expect((await b.boite.lire(b.connecteur.appels[0]!.cle))?.etat).toBe("a_trancher");
    expect((await b.lancer()).statut).toBe("a_trancher");
    expect(b.connecteur.appels).toHaveLength(1);
  });

  it("[A-319] @anti-doublon attaque : deux exécutions d'une même instance ont des clés distinctes et ne se lisent pas", async () => {
    const b = banc({ e1: envoyer }, "au_plus_une_fois");
    expect((await b.lancer("exec-1")).statut).toBe("terminee");
    expect((await b.lancer("exec-2")).statut).toBe("terminee");
    expect(b.connecteur.appels).toHaveLength(2);
    expect(b.connecteur.appels[0]?.cle).not.toBe(b.connecteur.appels[1]?.cle);
  });

  it("[A-319] @anti-doublon la clé dérivée est stable, sans ambiguïté de séparateur", () => {
    const k = (instanceId: string, executionId: string) => deriverCleIntention({ instanceId, executionId, etape: "e", action: "envoyer", element: "m" });
    expect(k("i", "x")).toBe(k("i", "x"));
    expect(k("ab", "c")).not.toBe(k("a", "bc"));
    expect(k("i", "x")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe("politique des erreurs", () => {
  it("[A-320] passagere : 5 essais au plus, attentes croissantes, aléa borné", async () => {
    const b = banc({ e1: envoyer });
    b.horloge.aleas = [5, -3, Number.NaN, 0.99];
    b.connecteur.programmer(...Array.from({ length: 5 }, () => new ErreurConnecteur("passagere", "reseau_coupe")));
    const r = await b.lancer();
    expect(r.statut).toBe("echec");
    expect(b.connecteur.appels).toHaveLength(5);
    expect(new Set(b.connecteur.appels.map((a) => a.cle)).size).toBe(1);
    expect(b.horloge.attentes).toHaveLength(4);
    b.horloge.attentes.forEach((ms, i) => {
      const base = 1000 * 2 ** i;
      expect(ms).toBeGreaterThanOrEqual(base);
      expect(ms).toBeLessThanOrEqual(base * 1.5);
    });
    expect(b.console.evenements.at(-1)).toMatchObject({ type: "erreur", classe: "passagere", code: "essais_epuises" });
  });

  it("[A-321] quota : attente jusqu'à la date donnée par l'outil", async () => {
    const b = banc({ e1: envoyer });
    b.connecteur.programmer(new ErreurConnecteur("quota", "limite_atteinte", b.horloge.maintenant() + 30_000));
    expect((await b.lancer()).statut).toBe("terminee");
    expect(b.horloge.attentes).toEqual([30_000]);
  });

  it("[A-321] attaque : une horloge qui recule pendant l'exécution donne une durée de zéro, pas négative", async () => {
    const b = banc({ e1: async () => b.horloge.regler(0) });
    await b.lancer();
    expect(b.console.evenements.at(-1)).toMatchObject({ type: "fin", dureeMs: 0 });
  });

  it("[A-322] identification : instance en pause, aucun autre essai", async () => {
    const b = banc({ e1: envoyer });
    b.connecteur.programmer(new ErreurConnecteur("identification", "jeton_refuse"));
    expect((await b.lancer()).statut).toBe("pause");
    expect(b.console.etat).toBe("pause");
    expect(b.console.evenements.at(-1)).toMatchObject({ type: "erreur", classe: "identification" });
    expect((await b.lancer("exec-2")).statut).toBe("ignoree");
    expect(b.connecteur.appels).toHaveLength(1);
  });

  it("[A-323] definitive : un événement erreur sans texte libre", async () => {
    const b = banc({ e1: envoyer });
    b.connecteur.programmer(new ErreurConnecteur("definitive", "Refus avec texte libre !"));
    expect((await b.lancer()).statut).toBe("echec");
    const e = b.console.evenements.at(-1);
    expect(e).toMatchObject({ type: "erreur", classe: "definitive", code: "erreur_inconnue" });
    expect(Object.keys(e!).sort()).toEqual(["classe", "code", "executionId", "instanceId", "type"]);
    expect(b.connecteur.appels).toHaveLength(1);
  });

  it("[A-323] attaque : une erreur non classée sort en definitive, sans renvoi, et son message ne sort pas", async () => {
    let essais = 0;
    const b = banc({
      e1: async () => {
        essais++;
        throw new TypeError("contact@exemple.fr introuvable");
      },
    });
    expect((await b.lancer()).statut).toBe("echec");
    expect(essais).toBe(1);
    expect(JSON.stringify(b.console.evenements)).not.toContain("exemple.fr");
    expect(b.console.evenements.at(-1)).toMatchObject({ classe: "definitive", code: "erreur_inconnue" });
  });

  it("[A-324] une étape de plus de 120 s est coupée", async () => {
    const departs: number[] = [];
    const signaux: AbortSignal[] = [];
    const b = banc({
      e1: async (ctx) => {
        departs.push(b.horloge.maintenant());
        signaux.push(ctx.signal);
        if (departs.length === 1) await new Promise<never>(() => undefined);
      },
    });
    expect((await b.lancer()).statut).toBe("terminee");
    expect(signaux[0]?.aborted).toBe(true);
    const ecart = departs[1]! - departs[0]!;
    expect(ecart).toBeGreaterThanOrEqual(121_000);
    expect(ecart).toBeLessThanOrEqual(121_500);
  });

  it("attaque : une action absente des connecteurs du module est refusée avant toute intention", async () => {
    const b = banc({ e1: async (ctx) => void (await ctx.effet("supprimer", "x", {})) });
    expect((await b.lancer()).statut).toBe("echec");
    expect(b.console.evenements.at(-1)).toMatchObject({ classe: "definitive", code: "action_non_declaree" });
    expect(b.connecteur.appels).toHaveLength(0);
    expect(b.boite.toutes()).toHaveLength(0);
  });
});

describe("attaques de l'audit (tour 1)", () => {
  const garanties: Garantie[] = ["idempotent_par_cle", "verifiable_apres_coup", "au_plus_une_fois"];

  it.each(garanties)("[A-319] @anti-doublon deux lancements simultanés (%s) : un seul appel à l'outil, le second rend la main", async (g) => {
    const b = banc({ e1: envoyer }, g);
    const statuts = (await Promise.all([b.lancer(), b.lancer()])).map((r) => r.statut).sort();
    expect(statuts).toEqual(["en_cours", "terminee"]);
    expect(b.connecteur.appels).toHaveLength(1);
    expect(b.connecteur.effetsReels).toBe(1);
    expect((await b.boite.toutes())[0]?.etat).toBe("faite");
  });

  it("[C-539] @anti-doublon une action hors de la liste du client n'est jamais appelée", async () => {
    const b = banc({ e1: envoyer }, "idempotent_par_cle", { reglages: { actionsAutomatiquesAutorisees: [], objetAccuse: "Accusé" } });
    expect((await b.lancer()).statut).toBe("echec");
    expect(b.console.evenements.at(-1)).toMatchObject({ classe: "definitive", code: "action_non_autorisee" });
    expect(b.connecteur.appels).toHaveLength(0);
    expect(b.boite.toutes()).toHaveLength(0);
  });

  it("[A-324] attaque : le travail d'une étape coupée ne peut plus agir (signal), même après le nouvel essai", async () => {
    let essais = 0;
    const b = banc({
      e1: async (ctx) => {
        if (essais++ > 0) return void (await ctx.effet("envoyer", "m2"));
        await b.horloge.attendre(200_000);
        await ctx.effet("envoyer", "orphelin");
      },
    });
    expect((await b.lancer()).statut).toBe("terminee");
    await b.horloge.piloter(b.horloge.attendre(300_000));
    expect(b.connecteur.appels).toHaveLength(1);
    expect(b.boite.toutes().map((i) => i.element)).toEqual(["m2"]);
  });

  it("[A-324] attaque : un délai géant est borné à une heure, l'étape n'est pas coupée tout de suite", async () => {
    const b = banc({ e1: envoyer }, "idempotent_par_cle", { delai: 3_000_000 });
    const vus: number[] = [];
    const attendre = b.horloge.attendre.bind(b.horloge);
    b.horloge.attendre = (ms, signal) => (signal && vus.push(ms), attendre(ms, signal));
    expect((await b.lancer()).statut).toBe("terminee");
    expect(vus).toEqual([3_600_000]);
    expect(b.connecteur.appels).toHaveLength(1);
  });

  it("[A-319] @anti-doublon attaque : deux instances qui partagent un executionId ne sautent pas leurs étapes", async () => {
    const b = banc({ e1: envoyer });
    await b.horloge.piloter(b.machine.lancer("inst-A", "tache-1"));
    expect((await b.horloge.piloter(b.machine.lancer("inst-B", "tache-1"))).statut).toBe("terminee");
    expect(b.connecteur.appels).toHaveLength(2);
  });

  it("[A-319] @anti-doublon attaque : deux actions sur un même élément ont chacune leur clé et partent toutes deux (C4 v0.2.0)", async () => {
    const b = banc({
      e1: async (ctx) => {
        await ctx.effet("envoyer", "m1");
        await ctx.effet("classer", "m1");
      },
    });
    expect((await b.lancer()).statut).toBe("terminee");
    expect(b.connecteur.appels).toHaveLength(2);
    expect(b.connecteur.appels[0]?.cle).not.toBe(b.connecteur.appels[1]?.cle);
  });

  it("[A-285] attaque : une configuration d'une autre instance ou d'un autre module est refusée", async () => {
    for (const autre of [{ instanceId: "inst-X" }, { moduleCode: "autre-module" }]) {
      const b = banc({ e1: envoyer });
      const lire = b.console.lireConfiguration.bind(b.console);
      b.console.lireConfiguration = async (id) => ({ ...(await lire(id)), ...autre });
      expect((await b.lancer()).statut).toBe("echec");
      expect(b.console.evenements.at(-1)).toMatchObject({ classe: "definitive", code: "configuration_incoherente" });
      expect(b.connecteur.appels).toHaveLength(0);
    }
  });

  it("[A-285] attaque : un état voulu d'une autre instance est refusé", async () => {
    const b = banc({ e1: envoyer });
    const lire = b.console.lireEtatVoulu.bind(b.console);
    b.console.lireEtatVoulu = async (id) => ({ ...(await lire(id)), instanceId: "inst-X" });
    expect((await b.lancer()).statut).toBe("echec");
    expect(b.connecteur.appels).toHaveLength(0);
  });

  it("[A-323] attaque : après un échec définitif, la relivraison ne rejoue pas l'étape et n'envoie pas un second événement", async () => {
    const b = banc({ e1: envoyer });
    b.connecteur.programmer(new ErreurConnecteur("definitive", "refus_outil"));
    expect((await b.lancer()).statut).toBe("echec");
    const avant = b.console.evenements.length;
    expect((await b.lancer()).statut).toBe("echec");
    expect(b.console.evenements).toHaveLength(avant);
    expect(b.connecteur.appels).toHaveLength(1);
  });

  it("[A-322] attaque : une pause ou un arrêt pendant l'exécution est respecté à l'étape suivante", async () => {
    const b = banc({
      e1: async () => void (b.console.etat = "arrete"),
      e2: envoyer,
    });
    expect((await b.lancer()).statut).toBe("ignoree");
    expect(b.connecteur.appels).toHaveLength(0);
  });
});

describe("attaques de l'audit (tour 2)", () => {
  const garanties: Garantie[] = ["idempotent_par_cle", "verifiable_apres_coup", "au_plus_une_fois"];
  const longue = (b: ReturnType<typeof banc>, ms: number) => {
    b.connecteur.surAppel = async () => void (await b.horloge.attendre(ms));
  };

  it.each(garanties)("[A-316] @anti-doublon un appel en vol plus long que l'étape garde son bail : le nouvel essai ne rappelle pas l'outil (%s)", async (g) => {
    const b = banc({ e1: envoyer }, g, { delai: 10 });
    longue(b, 30_000);
    expect((await b.lancer()).statut).toBe("en_cours");
    expect(b.connecteur.appels).toHaveLength(1);
    await b.horloge.piloter(b.horloge.attendre(25_000));
    expect(b.connecteur.appels).toHaveLength(1);
  });

  it("[A-316] @anti-doublon un appel coupé par le signal ne rend pas son bail", async () => {
    const b = banc({ e1: envoyer }, "verifiable_apres_coup", { delai: 10 });
    let liberations = 0;
    const liberer = b.boite.liberer.bind(b.boite);
    b.boite.liberer = async (cle, proprietaire) => void (liberations++, await liberer(cle, proprietaire));
    b.connecteur.surAppel = async () => {
      await b.horloge.attendre(30_000);
      throw new ErreurConnecteur("passagere", "coupe");
    };
    expect((await b.lancer()).statut).toBe("en_cours");
    await b.horloge.piloter(b.horloge.attendre(25_000));
    expect(liberations).toBe(0);
    expect(b.boite.toutes()[0]?.bail).toBeDefined();
  });

  it.each(garanties)("[A-316] @anti-doublon un lancement perdant n'inscrit aucun échec et n'envoie ni erreur ni fin (%s)", async (g) => {
    const b = banc({ e1: envoyer }, g);
    longue(b, 60_000);
    const statuts = (await Promise.all([b.lancer(), b.lancer()])).map((r) => r.statut).sort();
    expect(statuts).toEqual(["en_cours", "terminee"]);
    expect((await b.journal.lire("inst-1", "exec-1")).filter((e) => e.statut === "echec")).toHaveLength(0);
    expect(b.console.evenements.filter((e) => e.type === "erreur")).toHaveLength(0);
    expect(b.console.evenements.filter((e) => e.type === "fin")).toHaveLength(1);
    expect(b.connecteur.appels).toHaveLength(1);
  });

  it("[A-315] le gagnant coupé à l'étape 2 : la reprise finit, le perdant n'a rien empoisonné", async () => {
    let coupure = true;
    const b = banc({
      e1: envoyer,
      e2: async () => {
        if (coupure) throw new CoupureProcessus();
      },
    });
    longue(b, 60_000);
    const r = await Promise.allSettled([b.lancer(), b.lancer()]);
    expect(r.filter((x) => x.status === "rejected")).toHaveLength(1);
    apresCoupure(b);
    coupure = false;
    expect((await b.lancer()).statut).toBe("terminee");
  });

  it("[A-319] @anti-doublon un bail repris par un autre : l'effet n'est pas compté, l'intention reste à trancher", async () => {
    const b = banc({ e1: envoyer }, "idempotent_par_cle");
    b.boite.marquerFaite = async () => false;
    expect((await b.lancer()).statut).toBe("a_trancher");
  });

  it("[A-285] attaque : l'état voulu relu avant une étape doit porter l'instance demandée", async () => {
    const b = banc({ e1: async () => undefined, e2: envoyer });
    const lire = b.console.lireEtatVoulu.bind(b.console);
    let n = 0;
    b.console.lireEtatVoulu = async (id) => ({ ...(await lire(id)), instanceId: n++ === 0 ? id : "inst-X" });
    expect((await b.lancer()).statut).toBe("echec");
    expect(b.connecteur.appels).toHaveLength(0);
  });
});

describe("contexte d'étape (C4 v0.2.0)", () => {
  it("[LOT4-c4] le contexte donné à l'étape ne porte que les clés de C4", async () => {
    let cles: string[] = [];
    const b = banc({ e1: async (ctx) => void (cles = Object.keys(ctx).sort()) });
    await b.lancer();
    expect(cles).toEqual([...CLES_CONTEXTE].sort());
  });

  it("[LOT4-c4] sans passerelle branchée, l'IA échoue en erreur définitive sans texte", async () => {
    const b = banc({ e1: async (ctx) => void (await ctx.ia.completer({ modele: "m", entree: "x" })) });
    expect((await b.lancer()).statut).toBe("echec");
    expect(b.console.evenements.at(-1)).toMatchObject({ classe: "definitive", code: "ia_indisponible" });
  });
});
