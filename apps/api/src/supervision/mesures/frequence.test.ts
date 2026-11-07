import { describe, expect, it } from "vitest";
import { estEnRetard, frequenceMs, prochaineAttendue } from "./frequence.js";

const cronHoraire = { type: "cron", expression: "0 * * * *" } as const;

describe("fréquence attendue", () => {
  it("[B-383] une instance cron horaire sans réussite depuis 2 h 01 est en retard", () => {
    const derniere = new Date("2026-11-06T10:00:00Z");
    expect(estEnRetard(cronHoraire, derniere, new Date("2026-11-06T12:01:00Z"))).toBe(true);
    expect(estEnRetard(cronHoraire, derniere, new Date("2026-11-06T11:59:00Z"))).toBe(false);
  });

  it("[B-383] la fréquence d'un cron horaire est une heure et celle d'un sondage vient de son intervalle", () => {
    expect(frequenceMs(cronHoraire, new Date("2026-11-06T10:00:00Z"))).toBe(3_600_000);
    expect(frequenceMs({ type: "sondage", intervalleSecondes: 300 }, new Date())).toBe(300_000);
  });

  it("[B-383] la prochaine exécution attendue suit la dernière réussite", () => {
    expect(prochaineAttendue(cronHoraire, new Date("2026-11-06T10:20:00Z"))?.toISOString()).toBe("2026-11-06T11:00:00.000Z");
    expect(prochaineAttendue({ type: "cron", expression: "30 6 * * 1-5" }, new Date("2026-11-06T10:00:00Z"))?.toISOString()).toBe("2026-11-09T06:30:00.000Z");
  });

  it("[B-383] une instance sans déclencheur n'est jamais en retard", () => {
    expect(estEnRetard(null, new Date("2026-01-01T00:00:00Z"), new Date("2026-11-06T00:00:00Z"))).toBe(false);
    expect(prochaineAttendue({ type: "cron", expression: "pas un cron" }, new Date())).toBeNull();
  });
});
