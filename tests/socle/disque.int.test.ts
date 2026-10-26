import { describe, it } from "vitest";

// Tests contre le socle (job socle-integration). Ils attendent la brique de sauvegardes de T1A-14 (#59 :
// pgBackRest, cible SFTP, option archive-push-queue-max) : tant qu'elle n'est pas sur main, ils restent à faire.
describe("disque plein", () => {
  it.todo("[C-602] archivage coupé (cible SFTP arrêtée) et écriture continue : l'alerte de saturation arrive dans le récepteur de test avant 80 % du disque");
  it.todo("[C-602] le plafond des journaux en attente est atteint avant que le disque soit plein, et la base accepte encore des écritures");
  it.todo("[C-602] l'alerte « archivage interrompu » part quand des journaux sont abandonnés");
});
