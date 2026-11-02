import { describe, expect, it } from "vitest";
import { ErreurHeritage, NIVEAUX, resoudre, verifierEcriture, type NiveauxConnus } from "./index.ts";

// Graine fixe : un échec se rejoue à l'identique (fiche T2-08, pièges).
function melangeur(graine: number) {
  let s = graine >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TOUS: NiveauxConnus = {
  global: { remise: { valeur: 1, version: 1 } },
  automatisation: { remise: { valeur: 2, version: 2 } },
  metier: { remise: { valeur: 3, version: 3 } },
  client: { remise: { valeur: 4, version: 4 } },
  instance: { remise: { valeur: 5, version: 5 } },
};

describe("résolution des valeurs par niveau", () => {
  it("[A-160] @argent la valeur de l'instance l'emporte sur celle du client, qui l'emporte sur le métier, l'automatisation, le global", () => {
    expect(NIVEAUX).toEqual(["global", "automatisation", "metier", "client", "instance"]);
    let niveaux: NiveauxConnus = TOUS;
    for (const attendu of ["instance", "client", "metier", "automatisation", "global"] as const) {
      const r = resoudre("remise", niveaux);
      expect(r?.source).toBe(attendu);
      expect(r?.valeur).toBe(TOUS[attendu]?.["remise"]?.valeur);
      expect(r?.version).toBe(TOUS[attendu]?.["remise"]?.version);
      niveaux = Object.fromEntries(Object.entries(niveaux).filter(([nom]) => nom !== attendu)) as NiveauxConnus;
    }
    expect(resoudre("remise", {})).toBeNull();
  });

  it("[A-160] une valeur absente passe au niveau suivant ; un null explicite reste null", () => {
    expect(resoudre("remise", { global: { remise: { valeur: 500 } }, client: { frais: { valeur: 1 } } })).toMatchObject({ valeur: 500, source: "global" });
    const annulee = resoudre("remise", { global: { remise: { valeur: 500 } }, client: { remise: { valeur: null } } });
    expect(annulee).toMatchObject({ valeur: null, source: "client" });
    expect(resoudre("remise", { global: { remise: { valeur: 500 } }, client: { remise: undefined } })).toMatchObject({ valeur: 500, source: "global" });
  });

  it("[A-160] @argent mêmes entrées, même résultat (1000 tirages aléatoires d'ordre)", () => {
    const hasard = melangeur(20261102);
    const reference = JSON.stringify(resoudre("remise", TOUS));
    for (let i = 0; i < 1000; i++) {
      const cles = Object.keys(TOUS).sort(() => hasard() - 0.5);
      const melange = Object.fromEntries(cles.map((k) => [k, TOUS[k as keyof NiveauxConnus]])) as NiveauxConnus;
      expect(JSON.stringify(resoudre("remise", melange))).toBe(reference);
    }
  });

  it("[A-160] un niveau inconnu est refusé, et une clé héritée du prototype n'est jamais une valeur", () => {
    expect(() => resoudre("remise", { quelconque: { remise: { valeur: 1 } } } as never)).toThrow(ErreurHeritage);
    expect(resoudre("toString", { global: {} })).toBeNull();
    expect(resoudre("__proto__", { global: {} })).toBeNull();
  });

  it("[B-515] une valeur imposée au niveau plateforme n'est pas modifiable au niveau client ni instance", () => {
    const niveaux: NiveauxConnus = {
      global: { engagement: { valeur: 12, imposee: true, version: 7 } },
      client: { engagement: { valeur: 1 } },
      instance: { engagement: { valeur: 3 } },
    };
    expect(resoudre("engagement", niveaux)).toMatchObject({ valeur: 12, source: "global", version: 7, imposee: true });
    // Refus à l'écriture, pas seulement à la lecture.
    for (const niveau of ["automatisation", "metier", "client", "instance"] as const) {
      expect(() => verifierEcriture("engagement", niveau, niveaux)).toThrow(/valeur_imposee/);
    }
    expect(() => verifierEcriture("engagement", "global", niveaux)).not.toThrow();
    expect(() => verifierEcriture("remise", "client", niveaux)).not.toThrow();
  });

  it("[B-515] le profil de marque du client est lu par deux modules sans copie", () => {
    const profil = Object.freeze({ fuseau: "Europe/Paris", fenetres: Object.freeze(["09:00-12:00"]) });
    const client = { profil_marque: { valeur: profil, version: 3 } };
    const moduleA = resoudre("profil_marque", { client, instance: { delai: { valeur: 1 } } });
    const moduleB = resoudre("profil_marque", { client, instance: { delai: { valeur: 2 } } });
    expect(moduleA?.valeur).toBe(profil);
    expect(moduleB?.valeur).toBe(profil);
    expect(moduleA).toMatchObject({ source: "client", version: 3 });
  });
});
