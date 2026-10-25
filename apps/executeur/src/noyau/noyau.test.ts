import { describe, expect, it } from "vitest";
import { defineAutomation, type Garantie } from "@axion-auto/sdk-module";
import { manifesteExemple, moduleExemple } from "@axion-auto/sdk-module/exemples/module-exemple.ts";
import {
  BoiteEnMemoire,
  CLES_JOURNAL,
  ConnecteurFactice,
  ConsoleFactice,
  CoupureProcessus,
  ErreurConnecteur,
  HorlogeFactice,
  JournalEnMemoire,
  Machine,
  decider,
  deriverCle,
  lierEtapes,
  type ContexteEtape,
} from "./index.ts";

const REGLAGES = { actionsAutomatiquesAutorisees: ["envoyer"], objetAccuse: "Accusé" };
type Corps = (ctx: ContexteEtape) => Promise<void>;
const envoyer: Corps = async (ctx) => {
  await ctx.effet("envoyer", "msg-1", { objet: "x" });
};

function banc(corps: Record<string, Corps>, garantie: Garantie = "idempotent_par_cle") {
  const module = defineAutomation({
    ...manifesteExemple,
    etapes: Object.keys(corps).map((nom) => ({ nom })),
    connecteurs: [{ famille: "messagerie", actions: ["envoyer"], portees: ["envoi"], garantie }],
  });
  const horloge = new HorlogeFactice();
  const journal = new JournalEnMemoire();
  const boite = new BoiteEnMemoire();
  const connecteur = new ConnecteurFactice();
  const console = new ConsoleFactice({ reglages: REGLAGES });
  const etapes = Object.fromEntries(Object.entries(corps).map(([nom, executer]) => [nom, { executer }]));
  const machine = new Machine({ module, etapes, ports: { journal, boite, connecteurs: connecteur, console, horloge } });
  const lancer = (executionId = "exec-1") => horloge.piloter(machine.lancer("inst-1", executionId));
  return { horloge, journal, boite, connecteur, console, machine, lancer };
}

// Simule un arrêt brutal juste après l'appel du connecteur, avant la marque « faite ».
function couperUneFois(b: ReturnType<typeof banc>) {
  const marquer = b.boite.marquerFaite.bind(b.boite);
  let vivant = true;
  b.boite.marquerFaite = async (cle) => {
    if (!vivant) return marquer(cle);
    vivant = false;
    throw new CoupureProcessus();
  };
}

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
    coupure = false;
    expect((await b.lancer()).statut).toBe("terminee");
    expect(vues).toEqual(["e1", "e2", "e3"]);
  });

  it("[A-315] le module exemple du SDK tourne de bout en bout en mémoire", async () => {
    const horloge = new HorlogeFactice();
    const console = new ConsoleFactice({ reglages: { actionsAutomatiquesAutorisees: [], objetAccuse: "Accusé" } });
    let objet = "";
    const machine = new Machine({
      module: moduleExemple,
      etapes: { accuser: { executer: async (ctx) => void (objet = String(ctx.reglages.objetAccuse)) } },
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
    expect((await b.lancer()).statut).toBe("terminee");
    expect(b.connecteur.appels).toHaveLength(2);
    expect(b.connecteur.appels[1]?.cle).toBe(b.connecteur.appels[0]?.cle);
    expect(b.connecteur.effetsReels).toBe(1);
  });

  it("[A-318] @anti-doublon garantie verifiable_apres_coup : l'action trouvée sur l'outil n'est pas refaite", async () => {
    const b = banc({ e1: envoyer }, "verifiable_apres_coup");
    couperUneFois(b);
    await expect(b.lancer()).rejects.toBeInstanceOf(CoupureProcessus);
    expect((await b.lancer()).statut).toBe("terminee");
    expect(b.connecteur.appels).toHaveLength(1);
    expect(b.connecteur.effetsReels).toBe(1);
  });

  it("[A-318] @anti-doublon verifiable_apres_coup : réponse « inconnue » de l'outil → à trancher, jamais de renvoi", async () => {
    const b = banc({ e1: envoyer }, "verifiable_apres_coup");
    b.connecteur.verification = "inconnue";
    couperUneFois(b);
    await expect(b.lancer()).rejects.toBeInstanceOf(CoupureProcessus);
    expect((await b.lancer()).statut).toBe("a_trancher");
    expect(b.connecteur.appels).toHaveLength(1);
  });

  it("[A-319] @anti-doublon garantie au_plus_une_fois : aucune nouvelle tentative, cas « à trancher »", async () => {
    const b = banc({ e1: envoyer }, "au_plus_une_fois");
    couperUneFois(b);
    await expect(b.lancer()).rejects.toBeInstanceOf(CoupureProcessus);
    expect((await b.lancer()).statut).toBe("a_trancher");
    expect(b.connecteur.appels).toHaveLength(1);
    expect((await b.boite.lire(b.connecteur.appels[0]!.cle))?.etat).toBe("a_trancher");
    expect((await b.lancer()).statut).toBe("a_trancher");
    expect(b.connecteur.appels).toHaveLength(1);
  });

  it("[A-319] @anti-doublon attaque : deux lancements simultanés de la même exécution → un seul appel", async () => {
    const b = banc({ e1: envoyer }, "au_plus_une_fois");
    const statuts = (await Promise.all([b.lancer(), b.lancer()])).map((r) => r.statut).sort();
    expect(statuts).toEqual(["a_trancher", "terminee"]);
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
    expect(deriverCle("i", "x", "e", "m")).toBe(deriverCle("i", "x", "e", "m"));
    expect(deriverCle("ab", "c", "e", "m")).not.toBe(deriverCle("a", "bc", "e", "m"));
    expect(deriverCle("i", "x", "e", "m")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
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
    expect(b.console.evenements.at(-2)).toMatchObject({ type: "erreur", classe: "passagere", code: "essais_epuises" });
  });

  it("[A-321] quota : attente jusqu'à la date donnée par l'outil", async () => {
    const b = banc({ e1: envoyer });
    b.connecteur.programmer(new ErreurConnecteur("quota", "limite_atteinte", b.horloge.maintenant() + 30_000));
    expect((await b.lancer()).statut).toBe("terminee");
    expect(b.horloge.attentes).toEqual([30_000]);
  });

  it("[A-321] attaque : horloge qui recule, date passée, date absurde → attente jamais négative ni infinie", () => {
    const h = new HorlogeFactice(1_000);
    const attente = (jusqua?: number) => {
      const d = decider(new ErreurConnecteur("quota", "limite_atteinte", jusqua), 1, h);
      return d.action === "reessayer" ? d.attenteMs : -1;
    };
    expect(attente(500)).toBe(0);
    expect(attente(1e15)).toBe(86_400_000);
    for (const mauvais of [Number.NaN, Number.POSITIVE_INFINITY, undefined]) {
      const ms = attente(mauvais);
      expect(Number.isFinite(ms) && ms > 0).toBe(true);
    }
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
    b.connecteur.programmer(new ErreurConnecteur("definitive", "Refus de Jean Dupont !"));
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

  it("attaque : une étape déclarée sans code, ou du code sans étape déclarée, est refusé au chargement", () => {
    const e = { executer: async () => undefined };
    expect(() => lierEtapes(moduleExemple, {})).toThrow(/accuser/);
    expect(() => lierEtapes(moduleExemple, { accuser: e, fantome: e })).toThrow(/fantome/);
    expect(() => lierEtapes(moduleExemple, { accuser: e })).not.toThrow();
  });
});

describe("journal", () => {
  it("[A-286] le journal d'étapes ne contient aucun champ de contenu (liste fermée de clés)", async () => {
    const b = banc({ e1: envoyer });
    await b.lancer();
    const entrees = await b.journal.lire("exec-1");
    expect(entrees.length).toBeGreaterThan(0);
    for (const e of entrees) expect(Object.keys(e).sort()).toEqual([...CLES_JOURNAL].sort());
    expect(CLES_JOURNAL).toEqual(["instanceId", "executionId", "etape", "statut", "essai", "a"]);
    await expect(b.journal.inscrire({ ...entrees[0]!, objet: "texte du client" } as never)).rejects.toThrow(/objet/);
  });
});
