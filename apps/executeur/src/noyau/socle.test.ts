import { describe, expect, it } from "vitest";
import { CLES_JOURNAL, ErreurConnecteur, HorlogeFactice, JournalEnMemoire, classer, decider } from "./index.ts";

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
