import { describe, expect, it } from "vitest";
import { etatCellule, MUETTE_APRES_MS, type SignalCellule } from "./cellules.js";

const maintenant = new Date("2026-11-06T12:00:00Z");
const signal = (minutes: number, p: Partial<SignalCellule> = {}): SignalCellule => ({
  code: "auto-run-1", recuLe: new Date(maintenant.getTime() - minutes * 60_000), fileAttente: 4, travauxEnCours: 2, processeurPourcent: 37, ...p,
});

describe("cellules", () => {
  it("[B-384] le signal de vie met à jour la file et la charge de la cellule", () => {
    expect(etatCellule(signal(1), maintenant)).toEqual({ code: "auto-run-1", muette: false, fileAttente: 4, travauxEnCours: 2, processeurPourcent: 37 });
  });

  it("[B-384] une cellule muette depuis 10 minutes est marquée muette", () => {
    expect(MUETTE_APRES_MS).toBe(600_000);
    expect(etatCellule(signal(10), maintenant).muette).toBe(true);
    expect(etatCellule(signal(9), maintenant).muette).toBe(false);
  });

  it("[B-384] une cellule qui n'a jamais parlé est muette, sans valeur inventée", () => {
    expect(etatCellule({ code: "auto-run-1", recuLe: null }, maintenant)).toEqual({ code: "auto-run-1", muette: true });
  });
});
