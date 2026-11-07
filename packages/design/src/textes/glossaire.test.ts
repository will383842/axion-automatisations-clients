import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { glossaire, raccourcis } from "./glossaire.fr.js";

const sansAccent = (s: string): string => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

describe("glossaire de la console", () => {
  it("[A-018] chaque mot du glossaire a une explication d'une phrase en français simple", () => {
    expect(glossaire.length).toBeGreaterThanOrEqual(14);
    for (const { mot, definition } of glossaire) {
      expect(mot.trim()).not.toBe("");
      expect(definition.trim()).not.toBe("");
      expect(definition.endsWith(".")).toBe(true);
      expect(definition.length).toBeLessThanOrEqual(220);
      // une seule phrase : un seul point final, aucun autre point suivi d'un espace
      expect(/\.\s/.test(definition)).toBe(false);
    }
    const mots = glossaire.map((e) => sansAccent(e.mot));
    expect(new Set(mots).size).toBe(mots.length);
    expect(mots).toEqual([...mots].sort((a, b) => a.localeCompare(b, "fr")));
  });

  it("[LOT3-glossaire] aucune définition ne contient un mot du lexique interdit, un tutoiement, un prix ni « Grenoble »", () => {
    const { mots } = JSON.parse(readFileSync(new URL("../../../../scripts/lexique-interdit.json", import.meta.url), "utf8")) as { mots: string[] };
    const tutoiement = /(?<![\p{L}'’-])(?:tu|toi|ton|ta|tes|t['’])(?![\p{L}])/iu;
    const prix = /€|(?<![\p{L}\p{N}])(?:HT|TTC)(?![\p{L}\p{N}])/u;
    for (const { mot, definition } of glossaire) {
      for (const texte of [mot, definition]) {
        const bas = texte.toLowerCase();
        for (const interdit of mots) {
          expect(new RegExp(`(?<![\\p{L}\\p{N}])${interdit}(?![\\p{L}\\p{N}])`, "u").test(bas), `${mot} : « ${interdit} »`).toBe(false);
        }
        expect(tutoiement.test(texte), `${mot} : tutoiement`).toBe(false);
        expect(prix.test(texte), `${mot} : prix`).toBe(false);
        expect(/grenoble/i.test(texte)).toBe(false);
      }
    }
  });

  it("[B-225] les raccourcis clavier de la console sont listés", () => {
    const touches = raccourcis.map((r) => r.touches.join(" ").toLowerCase());
    for (const attendu of [/ctrl.*cmd.*k|cmd.*ctrl.*k/, /entrée/, /échap/, /↑|haut/, /↓|bas/]) {
      expect(touches.some((t) => attendu.test(t)), String(attendu)).toBe(true);
    }
    for (const r of raccourcis) {
      expect(r.touches.length).toBeGreaterThan(0);
      expect(r.effet.trim()).not.toBe("");
    }
  });
});
