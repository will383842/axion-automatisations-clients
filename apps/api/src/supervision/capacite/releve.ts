import type { FileMinimale } from "../../files/files.js";
import { nomBaseDe } from "../../provisionnement/etapes-base.js";
import { deposerReleve, releverBase, TYPE_TACHE_RELEVE, type BaseARelever, type MesureBase, type PortsReleve } from "../bases/releve.js";

// Relève horaire des bases (A-263) : planification, traitement et journal par code. Les lectures restent celles de supervision/bases/releve.ts.
export type CodeEchecReleve = "base_autre_client" | "nom_base_refuse" | "mesure_invalide" | "lecture_impossible";

export class ErreurReleve extends Error {
  constructor(readonly code: CodeEchecReleve) {
    super(code);
    this.name = "ErreurReleve";
  }
}

// Une tâche par base et par heure (jobId de deposerReleve) : rejouer la planification dans la même heure ne double rien.
export async function planifierReleveHoraire(file: FileMinimale, bases: BaseARelever[], maintenant: Date): Promise<number> {
  for (const b of bases) await deposerReleve(file, b, maintenant);
  return bases.length;
}

// La base doit être celle du client : sinon ses mesures seraient rangées sous un autre client. Refus avant toute lecture.
export async function releverBaseDuClient(ports: PortsReleve, base: BaseARelever): Promise<MesureBase> {
  if (base.nomBase !== nomBaseDe(base.tenantId)) throw new ErreurReleve("base_autre_client");
  try {
    return await releverBase(ports, base);
  } catch (e) {
    const m = e instanceof Error ? e.message : "";
    throw new ErreurReleve(m.startsWith("nom de base refusé") ? "nom_base_refuse" : m.startsWith("mesure invalide") ? "mesure_invalide" : "lecture_impossible");
  }
}

export async function traiterTacheReleve(ports: PortsReleve, tache: { name: string; data: { tenantId: string; nomBase: string } }): Promise<MesureBase> {
  if (tache.name !== TYPE_TACHE_RELEVE) throw new Error("type de tâche inattendu");
  return releverBaseDuClient(ports, { tenantId: tache.data.tenantId, nomBase: tache.data.nomBase });
}

// Une base en échec n'arrête pas les autres ; le journal reçoit un code et le nom de la base, jamais le message d'erreur (il peut citer une adresse ou un secret).
export async function releverLotJournalise(ports: PortsReleve, bases: BaseARelever[], journal: (code: CodeEchecReleve, nomBase: string) => void): Promise<{ relevees: number; echecs: number }> {
  let relevees = 0;
  let echecs = 0;
  for (const b of bases) {
    try {
      await releverBaseDuClient(ports, b);
      relevees += 1;
    } catch (e) {
      echecs += 1;
      journal(e instanceof ErreurReleve ? e.code : "lecture_impossible", b.nomBase);
    }
  }
  return { relevees, echecs };
}
