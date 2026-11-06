import { createHash } from "node:crypto";
import type { Repetition } from "./declencheurs.ts";

// Étalement (A-416) : décalage déterministe, en minutes, ajouté aux déclencheurs « cron » à heure fixe, pour que « tous les jours à 8 h » de milliers
// d'instances ne partent pas à la même seconde. Affiché à l'écran comme « vers 8 h ». 0 minute de fenêtre = pas d'étalement.
export function decalageMinutes(instanceId: string, fenetreMin: number): number {
  return createHash("sha256").update(instanceId).digest().readUInt32BE(0) % fenetreMin;
}

// Seules les expressions « minute heure * * * » (jour libre) ou avec jour de semaine/mois fixe sont décalées, sans jamais passer minuit :
// le jour d'un déclencheur hebdomadaire ne change pas. Toute autre expression (intervalles, listes) est laissée telle quelle.
export function etaler(rep: Repetition, instanceId: string, fenetreMin: number): Repetition {
  if (!("pattern" in rep) || !Number.isInteger(fenetreMin) || fenetreMin <= 0) return rep;
  const champs = rep.pattern.trim().split(/\s+/);
  const [m, h] = champs;
  if (champs.length !== 5 || !/^\d{1,2}$/.test(m!) || !/^\d{1,2}$/.test(h!) || Number(m) > 59 || Number(h) > 23) return rep;
  const base = Number(h) * 60 + Number(m);
  const total = base + decalageMinutes(instanceId, Math.min(fenetreMin, 1440 - base));
  return { ...rep, pattern: [String(total % 60), String(Math.floor(total / 60)), ...champs.slice(2)].join(" ") };
}
