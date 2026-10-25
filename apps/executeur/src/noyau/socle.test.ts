import { afterEach, describe, expect, it, vi } from "vitest";
import { BoiteEnMemoire, CLES_JOURNAL, ErreurConnecteur, HorlogeFactice, HorlogeSysteme, JournalEnMemoire, classer, decider } from "./index.ts";

describe("politique des erreurs", () => {
  it("[A-320] passagere : 5 essais au plus, attentes croissantes, aléa borné", () => {
    const h = new HorlogeFactice();
    h.aleas = [5, -3, Number.NaN, 0.99];
    const erreur = new ErreurConnecteur("passagere", "reseau_coupe");
    for (let essai = 1; essai <= 4; essai++) {
      const d = decider(erreur, essai, h);
      const base = 1000 * 2 ** (essai - 1);
      expect(d.action).toBe("reessayer");
      if (d.action === "reessayer") expect(d.attenteMs >= base && d.attenteMs <= base * 1.5).toBe(true);
    }
    expect(decider(erreur, 5, h)).toEqual({ action: "echec", classe: "passagere", code: "essais_epuises" });
  });

  it("[A-321] attaque : horloge qui recule, date passée, date absurde → attente jamais négative ni infinie", () => {
    const h = new HorlogeFactice(1_000);
    const attente = (jusqua?: number) => {
      const d = decider(new ErreurConnecteur("quota", "limite_atteinte", jusqua), 1, h);
      return d.action === "reessayer" ? d.attenteMs : -1;
    };
    expect(attente(31_000)).toBe(30_000);
    expect(attente(500)).toBe(0);
    expect(attente(1e15)).toBe(86_400_000);
    for (const mauvais of [Number.NaN, Number.POSITIVE_INFINITY, undefined]) {
      const ms = attente(mauvais);
      expect(Number.isFinite(ms) && ms > 0).toBe(true);
    }
  });

  it("[A-322] identification : pause, aucun autre essai", () => {
    expect(decider(new ErreurConnecteur("identification", "jeton_refuse"), 1, new HorlogeFactice())).toEqual({ action: "pause", code: "jeton_refuse" });
  });

  it("[A-323] definitive : code libre ou erreur non classée → erreur_inconnue, jamais le message", () => {
    expect(classer(new ErreurConnecteur("definitive", "Refus de la boîte !"))).toEqual({ classe: "definitive", code: "erreur_inconnue" });
    expect(classer(new TypeError("contact@exemple.fr introuvable"))).toEqual({ classe: "definitive", code: "erreur_inconnue" });
  });
});

describe("journal", () => {
  const entree = { instanceId: "inst-A", executionId: "x", etape: "e1", statut: "faite", essai: 1, a: "2026-01-01T00:00:00.000Z" } as const;

  it("[A-286] le journal d'étapes ne contient aucun champ de contenu (liste fermée de clés)", async () => {
    const j = new JournalEnMemoire();
    await j.inscrire(entree);
    for (const e of await j.lire("inst-A", "x")) expect(Object.keys(e).sort()).toEqual([...CLES_JOURNAL].sort());
    await expect(j.inscrire({ ...entree, objet: "texte du client" } as never)).rejects.toThrow(/objet/);
  });

  it("[A-286] attaque : deux instances qui partagent un executionId ne se lisent pas", async () => {
    const j = new JournalEnMemoire();
    await j.inscrire(entree);
    expect(await j.lire("inst-B", "x")).toEqual([]);
    expect(await j.lire("inst-A", "x")).toHaveLength(1);
  });
});

describe("boîte d'envoi", () => {
  const base = { cle: "k1", instanceId: "i", executionId: "x", etape: "e", element: "m", action: "envoyer", garantie: "verifiable_apres_coup" } as const;
  const bail = (proprietaire: string, jusqua = 1_000) => ({ proprietaire, jusqua });

  it("[A-316] @anti-doublon attaque : une intention « écrite » au bail vivant n'est pas rendue à un autre propriétaire", async () => {
    const b = new BoiteEnMemoire();
    expect(await b.ecrire(base, bail("a"), 0)).toMatchObject({ creee: true, occupee: false });
    expect(await b.ecrire(base, bail("b"), 500)).toMatchObject({ creee: false, occupee: true });
    expect(await b.ecrire(base, bail("b", 2_000), 1_000)).toMatchObject({ creee: false, occupee: false });
  });

  it("[A-316] @anti-doublon un bail libéré peut être repris tout de suite", async () => {
    const b = new BoiteEnMemoire();
    await b.ecrire(base, bail("a"), 0);
    await b.liberer("k1", "a");
    expect(await b.ecrire(base, bail("b"), 10)).toMatchObject({ occupee: false });
  });

  it("[A-319] @anti-doublon attaque : les transitions ne partent que de « écrite » et pour le propriétaire du bail", async () => {
    const b = new BoiteEnMemoire();
    await b.ecrire(base, bail("a"), 0);
    expect(await b.marquerFaite("k1", "autre")).toBe(false);
    expect(await b.marquerATrancher("k1", "a")).toBe(true);
    expect(await b.marquerFaite("k1", "a")).toBe(false);
    expect((await b.lire("k1"))?.etat).toBe("a_trancher");
  });
});

describe("horloge système", () => {
  afterEach(() => vi.useRealTimers());

  it("[A-324] attaque : une attente de plus de 2^31 ms est découpée, jamais coupée tout de suite", async () => {
    vi.useFakeTimers();
    const delais: number[] = [];
    const reel = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((f: () => void, ms: number) => (delais.push(ms), reel(f, ms))) as never);
    let fini = false;
    void new HorlogeSysteme().attendre(3_000_000_000).then(() => void (fini = true));
    await vi.advanceTimersByTimeAsync(2 ** 31);
    expect(fini).toBe(false);
    await vi.advanceTimersByTimeAsync(3_000_000_000 - 2 ** 31);
    expect(fini).toBe(true);
    expect(delais.every((d) => d <= 2 ** 31 - 1)).toBe(true);
  });
});
