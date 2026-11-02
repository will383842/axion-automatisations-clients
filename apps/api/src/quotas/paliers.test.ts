import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CHEMIN_CONFIG_QUOTAS, chargerConfigQuotas, lireConfigQuotas, quotasEffectifs } from "./paliers.js";

const PERSONNALISEE = JSON.stringify({
  essentiel: { base_octets: 10, fichiers_octets: 20, personnes: 30 },
  pro: { base_octets: 11, fichiers_octets: 21, personnes: 31 },
  etendu: { base_octets: 12, fichiers_octets: 22, personnes: 32 },
});

describe("quotas par palier : configuration", () => {
  it("[A-247] les quotas par défaut des paliers Essentiel, Pro et Étendu sont lus dans la configuration", () => {
    const c = chargerConfigQuotas();
    expect(Object.keys(c).sort()).toEqual(["essentiel", "etendu", "pro"]);
    for (const p of Object.values(c)) for (const v of Object.values(p)) expect(Number.isSafeInteger(v) && v > 0).toBe(true);
    // Chaque palier est plus large que le précédent, sur les trois quotas.
    for (const k of ["baseOctets", "fichiersOctets", "personnes"] as const) {
      expect(c.essentiel[k]).toBeLessThan(c.pro[k]);
      expect(c.pro[k]).toBeLessThan(c.etendu[k]);
    }
    // Ce sont bien les valeurs du texte lu qui sortent, pas des valeurs écrites dans le code.
    expect(lireConfigQuotas(PERSONNALISEE).pro).toEqual({ baseOctets: 11, fichiersOctets: 21, personnes: 31 });
  });

  it("[A-247] une configuration incomplète, négative, décimale ou avec une clé en trop est refusée", () => {
    const base = JSON.parse(PERSONNALISEE) as Record<string, Record<string, unknown>>;
    const casse = (f: (o: typeof base) => void) => { const o = structuredClone(base); f(o); return JSON.stringify(o); };
    expect(() => lireConfigQuotas("pas du json")).toThrow();
    expect(() => lireConfigQuotas(casse((o) => { delete o["pro"]; }))).toThrow();
    expect(() => lireConfigQuotas(casse((o) => { o["pro"]!["personnes"] = -1; }))).toThrow();
    expect(() => lireConfigQuotas(casse((o) => { o["pro"]!["personnes"] = 0; }))).toThrow();
    expect(() => lireConfigQuotas(casse((o) => { o["pro"]!["personnes"] = 1.5; }))).toThrow();
    expect(() => lireConfigQuotas(casse((o) => { o["pro"]!["prix"] = 1; }))).toThrow();
  });

  it("[A-247] le fichier de configuration ne porte que des quotas, aucune valeur commerciale", () => {
    const texte = readFileSync(CHEMIN_CONFIG_QUOTAS, "utf8");
    const cles = [...texte.matchAll(/"([a-z_]+)"\s*:/g)].map((m) => m[1]);
    expect(new Set(cles)).toEqual(new Set(["avertissement", "essentiel", "pro", "etendu", "base_octets", "fichiers_octets", "personnes"]));
    expect(texte).not.toMatch(/prix|tarif|montant|centime|\beur\b|€|\bttc\b|\bht\b/i);
  });

  it("[C-188] un client peut avoir un quota surchargé", () => {
    const c = lireConfigQuotas(PERSONNALISEE);
    expect(quotasEffectifs(c, "pro")).toEqual({ baseOctets: 11, fichiersOctets: 21, personnes: 31 });
    expect(quotasEffectifs(c, "pro", { personnes: 99 })).toEqual({ baseOctets: 11, fichiersOctets: 21, personnes: 99 });
    // Une surcharge nulle ou absente retombe sur le palier, jamais sur zéro.
    expect(quotasEffectifs(c, "pro", { personnes: null, baseOctets: undefined })).toEqual({ baseOctets: 11, fichiersOctets: 21, personnes: 31 });
    // Le palier d'un autre client n'est pas modifié par la surcharge.
    expect(quotasEffectifs(c, "essentiel").personnes).toBe(30);
    expect(() => quotasEffectifs(c, "pro", { personnes: -5 })).toThrow();
    expect(() => quotasEffectifs(c, "inconnu" as never)).toThrow();
  });
});
