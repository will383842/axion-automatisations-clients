import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CLE_VERROU_GRAPPE, prendreVerrou, type ClientVerrou } from "./verrou-grappe.js";

// Cause mesurée des 53300 de migrer-module.int.test.ts (PR #172, #173) : [A-236] de tests/donnees/grappe.int.test.ts sature EXPRÈS la grappe « donnees »
// (250 connexions ordinaires), pendant que d'autres fichiers .int.test.ts tournent en parallèle sur la même grappe. Le provisionneur a les places réservées
// (pg_use_reserved_connections) ; le rôle _mod_ ne les a pas : seule sa connexion est refusée. Rouge quand migrer-module finit après A-210, vert sinon.
const racine = fileURLToPath(new URL("../../../../", import.meta.url));
const ignores = new Set(["node_modules", ".git", "dist"]);
const fichiersInt = (dossier: string): string[] =>
  readdirSync(dossier, { withFileTypes: true }).flatMap((e) =>
    ignores.has(e.name) ? [] : e.isDirectory() ? fichiersInt(join(dossier, e.name)) : e.name.endsWith(".int.test.ts") ? [join(dossier, e.name)] : [],
  );

describe("verrou de la grappe données entre fichiers d'intégration", () => {
  it("[A-236] chaque .int.test.ts qui se connecte à la grappe données du socle partage le verrou de la grappe", () => {
    const surGrappe = fichiersInt(racine).filter((f) => readFileSync(f, "utf8").includes("socle-donnees-socket"));
    expect(surGrappe.length).toBeGreaterThanOrEqual(4);
    const sansVerrou = surGrappe.filter((f) => !/\b(grappePartagee|reserverGrappe)\(/.test(readFileSync(f, "utf8"))).map((f) => relative(racine, f));
    expect(sansVerrou).toEqual([]);
  });

  it("[A-236] la saturation de la grappe (A-236) se fait sous verrou EXCLUSIF, relâché après la retombée des connexions", () => {
    const texte = readFileSync(join(racine, "tests/donnees/grappe.int.test.ts"), "utf8");
    const debut = texte.indexOf('it("[A-236]');
    expect(debut).toBeGreaterThan(0);
    const essai = texte.slice(debut, texte.indexOf("}, 300_000);", debut));
    const prise = essai.indexOf("reserverGrappe(");
    expect(prise).toBeGreaterThan(0);
    // Pris avant la première connexion de la charge, rendu après l'attente de retombée.
    expect(prise).toBeLessThan(essai.indexOf("c.connect()"));
    expect(essai.lastIndexOf("liberer()")).toBeGreaterThan(essai.indexOf("toutesLesConnexions() === 0"));
  });

  const faux = (echec?: Error) => {
    const ordres: string[] = [];
    const etat = { ferme: false };
    const client: ClientVerrou = {
      connect: async () => undefined,
      on: () => undefined,
      query: async (texte: string, valeurs?: unknown[]) => {
        ordres.push(`${texte}${valeurs ? ` ${JSON.stringify(valeurs)}` : ""}`);
        if (echec && /pg_advisory_lock/.test(texte) && !/unlock/.test(texte)) throw echec;
        return {};
      },
      end: async () => { etat.ferme = true; },
    };
    return { client, ordres, etat };
  };

  it("[A-236] partagé : pg_advisory_lock_shared avec une attente bornée ; exclusif : pg_advisory_lock ; chacun rendu puis fermé", async () => {
    for (const exclusif of [false, true]) {
      const f = faux();
      const v = await prendreVerrou(() => f.client, { exclusif, attenteMs: 1234 });
      expect(f.ordres[0]).toBe("SET lock_timeout = 1234");
      expect(f.ordres[1]).toBe(`SELECT ${exclusif ? "pg_advisory_lock" : "pg_advisory_lock_shared"}($1) ["${CLE_VERROU_GRAPPE}"]`);
      await v.liberer();
      expect(f.ordres[2]).toBe(`SELECT ${exclusif ? "pg_advisory_unlock" : "pg_advisory_unlock_shared"}($1) ["${CLE_VERROU_GRAPPE}"]`);
      expect(f.etat.ferme).toBe(true);
    }
  });

  it("[A-236] une attente dépassée ferme la connexion du verrou et remonte l'erreur (aucune session laissée)", async () => {
    const f = faux(Object.assign(new Error("canceling statement due to lock timeout"), { code: "55P03" }));
    await expect(prendreVerrou(() => f.client, { exclusif: false, attenteMs: 10 })).rejects.toMatchObject({ code: "55P03" });
    expect(f.etat.ferme).toBe(true);
  });
});
