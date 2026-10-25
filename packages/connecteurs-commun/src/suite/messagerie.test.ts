import { describe, expect, it } from "vitest";
import { classer } from "../erreurs.ts";
import { verifierMessageId } from "../familles/messagerie.ts";
import { fabriqueRejouee } from "./enregistrements.ts";
import { lancer } from "./lanceur.ts";
import { CAS_MESSAGERIE, fabriqueMemoire, jouerSuite, type Fabrique } from "./messagerie.ts";

const manque = (fabrique: Fabrique, retire: string): Fabrique => async (s) => {
  const banc = await fabrique(s);
  return { ...banc, connecteur: { ...banc.connecteur, [retire]: undefined } as never };
};

describe("suite de contrat messagerie", () => {
  it("[A-405] la suite compte au moins 15 cas", () => {
    expect(CAS_MESSAGERIE.length).toBeGreaterThanOrEqual(15);
  });
  it("[A-405] le connecteur de référence en mémoire passe la suite", async () => {
    const rapport = await jouerSuite(fabriqueMemoire);
    expect(rapport.filter((r) => !r.ok)).toEqual([]);
  });
  it("[A-405] un connecteur factice incomplet échoue la suite", async () => {
    for (const m of ["listerNouveaux", "lire", "etiqueter", "creerBrouillon", "envoyer"]) {
      const rapport = await jouerSuite(manque(fabriqueMemoire, m));
      expect(rapport.some((r) => !r.ok), m).toBe(true);
    }
    await expect(lancer(manque(fabriqueMemoire, "envoyer"))).rejects.toThrow(/échoue/);
  });
  it("[A-405] la suite rejouée sur les réponses enregistrées passe, sans réseau", async () => {
    const reseau = globalThis.fetch;
    globalThis.fetch = (() => { throw new Error("réseau interdit"); }) as never;
    try {
      await lancer(fabriqueRejouee);
    } finally {
      globalThis.fetch = reseau;
    }
  });
  it("[A-405] un connecteur qui envoie deux fois échoue la suite (anti-doublon)", async () => {
    const double: Fabrique = async (s) => {
      const banc = await fabriqueMemoire(s);
      const envoyer = banc.connecteur.envoyer.bind(banc.connecteur);
      return { ...banc, connecteur: { ...banc.connecteur, envoyer: async (j, m) => { await envoyer(j, m); return envoyer(j, { ...m, messageId: `<bis.${m.messageId.slice(1)}` }); } } };
    };
    expect((await jouerSuite(double)).some((r) => !r.ok)).toBe(true);
  });
  it("[A-405] un connecteur dont le curseur ne progresse pas échoue la suite", async () => {
    const boucle: Fabrique = async (s) => {
      const banc = await fabriqueMemoire(s);
      return { ...banc, connecteur: { ...banc.connecteur, listerNouveaux: async () => ({ ids: ["m-1"], suivant: "c-0" }) } };
    };
    expect((await jouerSuite(boucle)).some((r) => !r.ok)).toBe(true);
  });
  it("[A-405] un connecteur qui renvoie un champ non demandé échoue la suite", async () => {
    const fuite: Fabrique = async (s) => {
      const banc = await fabriqueMemoire(s);
      const lire = banc.connecteur.lire.bind(banc.connecteur);
      return { ...banc, connecteur: { ...banc.connecteur, lire: async (j, id, champs) => ({ ...(await lire(j, id, champs)), corps: "fuite" }) } };
    };
    expect((await jouerSuite(fuite)).some((r) => !r.ok)).toBe(true);
  });
  it("[A-406] un connecteur qui laisse sortir une erreur brute échoue la suite", async () => {
    const brut: Fabrique = async (s) => {
      const banc = await fabriqueMemoire(s);
      return { ...banc, connecteur: { ...banc.connecteur, lire: async () => { throw new TypeError("fetch failed"); } } };
    };
    expect((await jouerSuite(brut)).some((r) => !r.ok)).toBe(true);
    expect(classer(new TypeError("fetch failed")).classe).toBe("definitive");
  });
  it("[A-400] un connecteur qui recopie le jeton dans son erreur échoue la suite", async () => {
    const bavard: Fabrique = async (s) => {
      const banc = await fabriqueMemoire(s);
      return { ...banc, connecteur: { ...banc.connecteur, lire: async (j) => { throw new Error(`refus pour ${String(j)} ${banc.valeurJeton}`); } } };
    };
    expect((await jouerSuite(bavard)).some((r) => !r.ok)).toBe(true);
  });
});

describe("identifiant de message posé à la création", () => {
  it("[A-405] un Message-ID vide, sans chevrons ou avec saut de ligne est refusé", () => {
    for (const v of ["", "abc@exemple.fr", "<abc>", "<a b@exemple.fr>", "<a@exemple.fr>\r\nBcc: x@exemple.fr", "<" + "a".repeat(300) + "@exemple.fr>"]) {
      expect(() => verifierMessageId(v), v).toThrow();
    }
    expect(verifierMessageId("<m-1.abc@exemple.fr>")).toBe("<m-1.abc@exemple.fr>");
  });
});
