// Retrait du détail des exécutions (A-180, C-039) : 90 jours, par PARTITION mensuelle entière, jamais par DELETE sur la date.
// Fermé par défaut (RETENTION_PURGE_ACTIVE) : fermé, on journalise la liste de ce qui serait retiré et on ne touche à rien.
// Refus (et note au journal) si la liste des clients de la partition est vide, si une exécution y est encore en cours, si l'agrégat d'un jour manque,
// ou si un client de la partition est sous gel pour litige (C-609). Juste avant le retrait, les agrégats de TOUTE la partition sont recalculés (upsert).
// Contraintes de l'adaptateur SQL (dette, spec/preuves.md LOT2-dette-T2-11-adaptateur) : part_config.retention reste NULL (sinon run_maintenance supprimerait
// sans interrupteur ni gel), rôle de maintenance dédié et nommé qui possède les partitions (pas console_app), lecture client par client sous RLS forcée.
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
  // Nombre d'exécutions encore `en_cours` dans la partition : un agrégat les compte à durée 0, donc incomplet.
  executionsEnCours(partition: Partition): Promise<number>;
  // Recalcule (upsert) les agrégats de tous les jours de la partition, y compris les lignes insérées en retard après l'agrégation de nuit.
  recalculerAgregats(partition: Partition): Promise<void>;
  retirerPartition(nom: string): Promise<void>;
}
// Interface de gelActif(tenantId) de T2-43 (gel pour litige) : l'implémentation réelle est branchée quand T2-43 est fusionnée.
export interface GelLitige {
  gelActif(tenantId: string): Promise<boolean>;
}
export type EvenementRetention =
  | { type: "purge_prevue_interrupteur_ferme"; partitions: string[] }
  | { type: "purge_refusee"; partition: string; motif: MotifRefusPurge }
  // Écrit AVANT le retrait : si le retrait échoue, l'intention reste au journal.
  | { type: "purge_intention"; partition: string }
  | { type: "purge_partition"; partition: string }
  | { type: "proposition_notes_prevue_interrupteur_ferme"; tenantId: string; noteIds: string[]; finContrat: string }
  | { type: "proposition_notes_refusee"; tenantId: string; notes: number; motif: "gel_pour_litige" }
  | { type: "proposition_suppression_notes"; tenantId: string; noteIds: string[]; finContrat: string };
export type MotifRefusPurge = "agregat_incomplet" | "gel_pour_litige" | "execution_en_cours" | "clients_inconnus";
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
  refusees: { partition: string; motif: MotifRefusPurge }[];
  prevues: string[];
}

async function sousGel(gel: GelLitige, tenants: string[]): Promise<boolean> {
  for (const t of tenants) if (await gel.gelActif(t)) return true;
  return false;
}

// Refus d'une partition, ou null si elle peut partir. Liste de clients vide = clients inconnus : on ne devine pas, on refuse.
async function motifDeRefus(o: OptionsPurge, p: Partition, verifierAgregats: boolean): Promise<MotifRefusPurge | null> {
  if (p.tenants.length === 0) return "clients_inconnus";
  if ((await o.depot.executionsEnCours(p)) > 0) return "execution_en_cours";
  if (verifierAgregats && (await o.depot.joursSansAgregat(p)).length > 0) return "agregat_incomplet";
  if (await sousGel(o.gel, p.tenants)) return "gel_pour_litige";
  return null;
}

export async function purgerExecutions(o: OptionsPurge): Promise<ResultatPurge> {
  const limite = new Date(o.maintenant.getTime() - JOURS_DETAIL * JOUR_MS).toISOString().slice(0, 10);
  const resultat: ResultatPurge = { retirees: [], refusees: [], prevues: [] };
  const retirables: Partition[] = [];
  const refuser = async (p: Partition, motif: MotifRefusPurge) => {
    resultat.refusees.push({ partition: p.nom, motif });
    await o.journal({ type: "purge_refusee", partition: p.nom, motif });
  };
  for (const p of await o.depot.partitionsTerminees(limite)) {
    // Garde de sécurité en plus du dépôt : une partition qui finit après la limite contient des exécutions de moins de 90 jours.
    if (p.fin > limite) continue;
    const refus = await motifDeRefus(o, p, true);
    if (refus) await refuser(p, refus);
    else retirables.push(p);
  }
  if (!o.active) {
    resultat.prevues = retirables.map((p) => p.nom);
    if (resultat.prevues.length) await o.journal({ type: "purge_prevue_interrupteur_ferme", partitions: resultat.prevues });
    return resultat;
  }
  for (const p of retirables) {
    // Gel, clients et exécutions en cours sont relus juste avant le retrait : ce qui a changé entre-temps l'emporte.
    const refus = await motifDeRefus(o, p, false);
    if (refus) {
      await refuser(p, refus);
      continue;
    }
    // Les agrégats de toute la partition sont refaits avant de perdre le détail (lignes insérées en retard, exécutions terminées depuis).
    await o.depot.recalculerAgregats(p);
    await o.journal({ type: "purge_intention", partition: p.nom });
    await o.depot.retirerPartition(p.nom);
    resultat.retirees.push(p.nom);
    await o.journal({ type: "purge_partition", partition: p.nom });
  }
  return resultat;
}
