import { describe, expect, it } from "vitest";
import { activer, declarer, interrupteurOuvert, vueAutomatisation } from "./famille.ts";

const base = {
  famille: "messagerie",
  outil: "outil-fictif",
  version: "1.2.3",
  capacites: [{ action: "lire", garantie: "idempotent_par_cle" }],
  portees: ["lecture"],
};

describe("déclaration d'un connecteur", () => {
  it("[A-333] un connecteur qui déclare une action hors de la famille est refusé", () => {
    expect(() => declarer({ ...base, capacites: [{ action: "supprimer_boite", garantie: "au_plus_une_fois" }] })).toThrow(/hors de la famille/);
  });
  it("[A-333] une famille inconnue est refusée", () => {
    expect(() => declarer({ ...base, famille: "calendrier-inconnu" })).toThrow();
  });
  it("[A-333] une action déclarée deux fois est refusée", () => {
    const c = { action: "lire", garantie: "idempotent_par_cle" };
    expect(() => declarer({ ...base, capacites: [c, c] })).toThrow(/deux fois/);
  });
  it("[A-396] un connecteur sans version semver est refusé", () => {
    for (const v of [undefined, "", "1.2", "01.2.3", "1.2.3; rm -rf", "latest", " 1.2.3"]) {
      expect(() => declarer({ ...base, version: v })).toThrow();
    }
    expect(declarer({ ...base, version: "2.0.0-rc.1" }).version).toBe("2.0.0-rc.1");
  });
  it("[A-395] une capacité sans garantie d'effet, ou avec une garantie inconnue, est refusée", () => {
    expect(() => declarer({ ...base, capacites: [{ action: "lire" }] })).toThrow();
    expect(() => declarer({ ...base, capacites: [{ action: "lire", garantie: "toujours_une_fois" }] })).toThrow();
  });
  it("[A-395] un champ inconnu dans la déclaration est refusé", () => {
    expect(() => declarer({ ...base, identifiant: "x" })).toThrow();
  });
  it("[A-394] une automatisation ne voit que les actions génériques, jamais l'outil", () => {
    const vue = vueAutomatisation(declarer(base));
    expect(vue).toEqual({ famille: "messagerie", actions: ["lire"] });
    expect(JSON.stringify(vue)).not.toContain("outil-fictif");
  });
  it("[A-400] l'interrupteur est fermé par défaut et seule la valeur « 1 » l'ouvre", () => {
    for (const env of [{}, { CONNECTEURS_MESSAGERIE_OUVERT: "" }, { CONNECTEURS_MESSAGERIE_OUVERT: "true" }, { CONNECTEURS_MESSAGERIE_OUVERT: "0" }]) {
      expect(interrupteurOuvert(env)).toBe(false);
      expect(() => activer(declarer(base), env)).toThrow(/fermé/);
    }
    expect(activer(declarer(base), { CONNECTEURS_MESSAGERIE_OUVERT: "1" }).outil).toBe("outil-fictif");
  });
});
