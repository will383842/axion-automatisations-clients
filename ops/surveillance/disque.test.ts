import { describe, expect, it } from "vitest";
import { decider, lireOccupation, messageAlerte, previsionSaturation, tailleDossier, type Mesure, type Parametres } from "./disque";

const HEURE = 3_600_000;
const GO = 1024 ** 3;
const PARAMS: Parametres = { seuilAlerte: 0.8, plafondJournaux: 2 * GO, horizonReveilMs: 6 * HEURE };

// Disque de 100 Go qui se remplit à vitesse constante, mesuré toutes les 10 minutes pendant 1 h.
function mesuresQuiMontent(debutOctets: number, octetsParHeure: number): Mesure[] {
  return Array.from({ length: 7 }, (_, i) => ({
    t: i * 600_000,
    utilises: debutOctets + (octetsParHeure * i) / 6,
    total: 100 * GO,
    journauxEnAttente: 0,
  }));
}

describe("disque", () => {
  it("[C-602] saturation prévue dans 5 h → reveil true ; dans 7 h → reveil false", () => {
    // À t = 1 h, 50 Go utilisés ; il reste 50 Go.
    const dans5h = decider(mesuresQuiMontent(40 * GO, 10 * GO), PARAMS, HEURE);
    expect(dans5h.saturationPrevue).toBeCloseTo(6 * HEURE, -4); // 5 h après « maintenant » (t = 1 h)
    expect(dans5h.reveil).toBe(true);
    const dans7h = decider(mesuresQuiMontent(50 * GO - (50 / 7) * GO, (50 / 7) * GO), PARAMS, HEURE);
    expect(dans7h.saturationPrevue).toBeCloseTo(8 * HEURE, -4);
    expect(dans7h.reveil).toBe(false);
  });

  it("[C-602] une alerte attend le matin quand la saturation est prévue dans plus de 6 h", () => {
    const d = decider(mesuresQuiMontent(81 * GO, 0.5 * GO), PARAMS, HEURE);
    expect(d.niveau).toBe("saturation_proche");
    expect(d.reveil).toBe(false);
  });

  it("[C-602] pas de prévision quand l'occupation ne monte pas", () => {
    expect(previsionSaturation(mesuresQuiMontent(30 * GO, 0))).toBeNull();
    expect(decider(mesuresQuiMontent(30 * GO, 0), PARAMS, HEURE).niveau).toBe("rien");
  });

  it("[C-602] le plafond des journaux atteint déclenche l'alerte d'archivage interrompu", () => {
    const m = mesuresQuiMontent(30 * GO, 0).map((x) => ({ ...x, journauxEnAttente: 2 * GO }));
    const d = decider(m, PARAMS, HEURE, { dernierArchivage: Date.UTC(2026, 9, 26, 1, 30), dernierEchec: Date.UTC(2026, 9, 26, 4, 0) });
    expect(d.niveau).toBe("plafond_atteint");
    expect(d.message).toContain("la reprise à un instant précis n'est plus garantie depuis 01:30 UTC");
  });

  it("[C-602] le message d'alerte ne contient ni nom d'hôte ni adresse IP", () => {
    const m = mesuresQuiMontent(85 * GO, 1 * GO);
    for (const options of [{}, { dernierArchivage: 0 }]) {
      const plein = m.map((x) => ({ ...x, journauxEnAttente: 3 * GO }));
      const messages = [decider(m, PARAMS, HEURE).message, decider(plein, PARAMS, HEURE, options).message, messageAlerte("saturation_proche", m[6]!, 1 * HEURE)];
      for (const msg of messages) {
        expect(msg).not.toMatch(/\d{1,3}(\.\d{1,3}){3}/);
        expect(msg).not.toMatch(/\b[\w-]+(\.[\w-]+)+\b(?<!\d)/);
        expect(msg).not.toMatch(/https?:|localhost|\.test|\.local/i);
      }
    }
  });

  const pleinA = (part: number) => mesuresQuiMontent(30 * GO, 0).map((x) => ({ ...x, journauxEnAttente: part * PARAMS.plafondJournaux }));

  it("[C-602] une alerte part avant le plafond, dès la moitié des journaux en attente", () => {
    expect(decider(pleinA(0.4), PARAMS, HEURE).niveau).toBe("rien");
    const d = decider(pleinA(0.5), PARAMS, HEURE);
    expect(d.niveau).toBe("plafond_proche");
    expect(d.reveil).toBe(false);
  });

  it("[C-602] des journaux abandonnés déclenchent l'alerte d'archivage interrompu même si la file est repassée sous le plafond", () => {
    const d = decider(pleinA(0.1), PARAMS, HEURE, { journauxAbandonnes: true });
    expect(d.niveau).toBe("plafond_atteint");
  });

  it("[C-602] au plafond, le réveil suit la prévision de saturation et n'est pas forcé", () => {
    expect(decider(pleinA(1), PARAMS, HEURE).reveil).toBe(false);
    const sature = mesuresQuiMontent(40 * GO, 10 * GO).map((x) => ({ ...x, journauxEnAttente: 2 * GO }));
    expect(decider(sature, PARAMS, HEURE).reveil).toBe(true);
  });

  it("[C-602] « depuis » donne le dernier archivage réussi, pas le dernier échec", () => {
    const d = decider(pleinA(1), PARAMS, HEURE, { dernierArchivage: Date.UTC(2026, 9, 26, 1, 30), dernierEchec: Date.UTC(2026, 9, 26, 5, 45) });
    expect(d.message).toContain("depuis 01:30 UTC");
    expect(d.message).not.toContain("05:45");
  });

  it("[C-602] le taux d'occupation tient compte de l'espace réservé (bavail, pas bfree)", () => {
    const o = lireOccupation("/x", () => ({ blocks: 1000, bfree: 100, bavail: 50, bsize: 1 }));
    expect(o.utilises).toBe(900);
    expect(o.total).toBe(950);
  });

  it("[C-602] tailleDossier ignore un fichier recyclé pendant la lecture", () => {
    const sys = {
      readdir: (d: string) => (d === "/w" ? ["a", "parti", "sous"] : ["b"]),
      lstat: (p: string) => {
        if (p === "/w/parti") throw Object.assign(new Error("absent"), { code: "ENOENT" });
        if (p === "/w/sous") return { isDirectory: () => true, size: 0 };
        return { isDirectory: () => false, size: p === "/w/a" ? 10 : 5 };
      },
    };
    expect(tailleDossier("/w", sys)).toBe(15);
    const autre = { ...sys, lstat: () => { throw Object.assign(new Error("refus"), { code: "EACCES" }); } };
    expect(() => tailleDossier("/w", autre)).toThrow();
  });
});
