import type { Journal } from "./journal.js";

// Tâche planifiée (T4-40) : parcourt les connexions proches de l'expiration ; une panne sur l'une n'arrête pas les autres.
export interface PortsBalayage {
  connexions(): Promise<readonly string[]>; // identifiants des connexions OAuth à examiner
  renouveler(connexionId: string): Promise<void>; // renouvelerSiBesoin décide s'il faut vraiment appeler le fournisseur
  journal: Pick<Journal, "tracer">;
}
export async function balayerRenouvellements(p: PortsBalayage): Promise<{ essayees: number; echecs: number }> {
  const ids = await p.connexions();
  let echecs = 0;
  for (const connexionId of ids) {
    try { await p.renouveler(connexionId); } catch { echecs++; p.journal.tracer({ evenement: "balayage_echec", connexionId }); }
  }
  return { essayees: ids.length, echecs };
}
