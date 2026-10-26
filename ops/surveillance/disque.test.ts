import { describe, expect, it } from "vitest";
import { decider, messageAlerte, previsionSaturation, type Mesure, type Parametres } from "./disque";

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
    const d = decider(m, PARAMS, HEURE, { dernierEchecArchivage: Date.UTC(2026, 9, 26, 1, 30) });
    expect(d.niveau).toBe("plafond_atteint");
    expect(d.message).toContain("la reprise à un instant précis n'est plus garantie depuis 01:30 UTC");
  });

  it("[C-602] le message d'alerte ne contient ni nom d'hôte ni adresse IP", () => {
    const m = mesuresQuiMontent(85 * GO, 1 * GO);
    for (const options of [{}, { dernierEchecArchivage: 0 }]) {
      const plein = m.map((x) => ({ ...x, journauxEnAttente: 3 * GO }));
      const messages = [decider(m, PARAMS, HEURE).message, decider(plein, PARAMS, HEURE, options).message, messageAlerte("saturation_proche", m[6]!, 1 * HEURE)];
      for (const msg of messages) {
        expect(msg).not.toMatch(/\d{1,3}(\.\d{1,3}){3}/);
        expect(msg).not.toMatch(/\b[\w-]+(\.[\w-]+)+\b(?<!\d)/);
        expect(msg).not.toMatch(/https?:|localhost|\.test|\.local/i);
      }
    }
  });
});
