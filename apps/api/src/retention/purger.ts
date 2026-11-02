// Retrait du détail des exécutions (A-180, C-039) : 90 jours, par PARTITION mensuelle entière, jamais par DELETE sur la date.
// Fermé par défaut (RETENTION_PURGE_ACTIVE) : fermé, on journalise la liste de ce qui serait retiré et on ne touche à rien.
// Refus (et note au journal) si l'agrégat d'un jour de la partition manque, ou si un client de la partition est sous gel pour litige (C-609).
export const JOURS_DETAIL = 90;
const JOUR_MS = 86_400_000;

export interface Partition {
  nom: string;
  // Premier jour NON couvert (AAAA-MM-JJ) : la partition ne contient que des exécutions antérieures.
  fin: string;
  tenants: string[];
}
// Port. L'adaptateur SQL liste les partitions de `executions`, cherche les (client, instance, jour) qui ont des exécutions sans ligne d'agrégat,
// et retire par pg_partman (détache puis supprime la partition, retention_keep_table = false).
export interface DepotPartitions {
  partitionsTerminees(avant: string): Promise<Partition[]>;
  joursSansAgregat(partition: Partition): Promise<string[]>;
  retirerPartition(nom: string): Promise<void>;
}
// Interface de gelActif(tenantId) de T2-43 (gel pour litige) : l'implémentation réelle est branchée quand T2-43 est fusionnée.
export interface GelLitige {
  gelActif(tenantId: string): Promise<boolean>;
}
export type EvenementRetention =
  | { type: "purge_prevue_interrupteur_ferme"; partitions: string[] }
  | { type: "purge_refusee"; partition: string; motif: "agregat_incomplet" | "gel_pour_litige" }
  | { type: "purge_partition"; partition: string }
  | { type: "retrait_notes_prevu_interrupteur_ferme"; notes: number }
  | { type: "retrait_notes_refuse"; tenantId: string; notes: number; motif: "gel_pour_litige" }
  | { type: "retrait_notes"; notes: number };
export type JournalRetention = (evenement: EvenementRetention) => Promise<void>;

export interface OptionsPurge {
  depot: DepotPartitions;
  gel: GelLitige;
  journal: JournalRetention;
  active: boolean;
  maintenant: Date;
}
export interface ResultatPurge {
  retirees: string[];
  refusees: { partition: string; motif: "agregat_incomplet" | "gel_pour_litige" }[];
  prevues: string[];
}

async function sousGel(gel: GelLitige, tenants: string[]): Promise<boolean> {
  for (const t of tenants) if (await gel.gelActif(t)) return true;
  return false;
}

export async function purgerExecutions(o: OptionsPurge): Promise<ResultatPurge> {
  const limite = new Date(o.maintenant.getTime() - JOURS_DETAIL * JOUR_MS).toISOString().slice(0, 10);
  const resultat: ResultatPurge = { retirees: [], refusees: [], prevues: [] };
  const retirables: Partition[] = [];
  for (const p of await o.depot.partitionsTerminees(limite)) {
    // Garde de sécurité en plus du dépôt : une partition qui finit après la limite contient des exécutions de moins de 90 jours.
    if (p.fin > limite) continue;
    const refus = (await o.depot.joursSansAgregat(p)).length > 0 ? "agregat_incomplet" : (await sousGel(o.gel, p.tenants)) ? "gel_pour_litige" : null;
    if (refus) {
      resultat.refusees.push({ partition: p.nom, motif: refus });
      await o.journal({ type: "purge_refusee", partition: p.nom, motif: refus });
    } else retirables.push(p);
  }
  if (!o.active) {
    resultat.prevues = retirables.map((p) => p.nom);
    if (resultat.prevues.length) await o.journal({ type: "purge_prevue_interrupteur_ferme", partitions: resultat.prevues });
    return resultat;
  }
  for (const p of retirables) {
    // Le gel est relu juste avant le retrait : un gel posé entre-temps l'emporte.
    if (await sousGel(o.gel, p.tenants)) {
      resultat.refusees.push({ partition: p.nom, motif: "gel_pour_litige" });
      await o.journal({ type: "purge_refusee", partition: p.nom, motif: "gel_pour_litige" });
      continue;
    }
    await o.depot.retirerPartition(p.nom);
    resultat.retirees.push(p.nom);
    await o.journal({ type: "purge_partition", partition: p.nom });
  }
  return resultat;
}
