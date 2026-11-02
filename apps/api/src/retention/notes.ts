import type { GelLitige, JournalRetention } from "./purger.js";

// Retrait des notes (C-041) : 3 ans après la fin du contrat. Même interrupteur fermé par défaut et même respect du gel pour litige (C-609)
// que la purge des exécutions. Seuls les identifiants et les comptes sortent au journal, jamais le texte d'une note.
export const ANNEES_NOTES = 3;
export interface NoteARetirer {
  id: string;
  tenantId: string;
}
// Port. L'adaptateur SQL lit les notes dont la fin de contrat (fins_de_contrat.date_fin) est antérieure à la limite, et les retire.
export interface DepotNotes {
  notesDeContratsFinisAvant(limite: string): Promise<NoteARetirer[]>;
  retirerNotes(ids: string[]): Promise<void>;
}
export interface ResultatNotes {
  retirees: string[];
  refusees: { tenantId: string; notes: number; motif: "gel_pour_litige" }[];
}

export async function purgerNotes(o: { depot: DepotNotes; gel: GelLitige; journal: JournalRetention; active: boolean; maintenant: Date }): Promise<ResultatNotes> {
  const limiteDate = new Date(o.maintenant);
  limiteDate.setUTCFullYear(limiteDate.getUTCFullYear() - ANNEES_NOTES);
  const resultat: ResultatNotes = { retirees: [], refusees: [] };
  const parClient = new Map<string, string[]>();
  for (const n of await o.depot.notesDeContratsFinisAvant(limiteDate.toISOString().slice(0, 10))) parClient.set(n.tenantId, [...(parClient.get(n.tenantId) ?? []), n.id]);
  const retirables: string[] = [];
  for (const [tenantId, ids] of parClient) {
    if (await o.gel.gelActif(tenantId)) {
      resultat.refusees.push({ tenantId, notes: ids.length, motif: "gel_pour_litige" });
      await o.journal({ type: "retrait_notes_refuse", tenantId, notes: ids.length, motif: "gel_pour_litige" });
    } else retirables.push(...ids);
  }
  if (!retirables.length) return resultat;
  if (!o.active) {
    await o.journal({ type: "retrait_notes_prevu_interrupteur_ferme", notes: retirables.length });
    return resultat;
  }
  await o.depot.retirerNotes(retirables);
  resultat.retirees = retirables;
  await o.journal({ type: "retrait_notes", notes: retirables.length });
  return resultat;
}
