import { exigerGelReel, type GelLitige, type JournalRetention } from "./purger.js";

// Fin de conservation des notes (C-041) : 3 ans après la fin du contrat, une PROPOSITION de suppression par client est soumise à Will.
// Jamais d'effacement automatique (règle de Will, ADR 0055 : « proposition de suppression soumise à Will, jamais un effacement automatique ») :
// le port n'a aucune méthode qui supprime une note. Même interrupteur fermé par défaut et même respect du gel pour litige (C-609).
// Seuls les identifiants, le client et la date de fin sortent au journal, jamais le texte d'une note.
export const ANNEES_NOTES = 3;
export interface NoteEnFinDeContrat {
  id: string;
  tenantId: string;
  // Date de fin de contrat (fins_de_contrat.date_fin, AAAA-MM-JJ).
  finContrat: string;
}
export interface PropositionSuppression {
  tenantId: string;
  noteIds: string[];
  // Fin de contrat la plus récente parmi les notes proposées.
  finContrat: string;
}
// Port. L'adaptateur SQL lit client par client (RLS forcée). `soumettreProposition` dépose la proposition à Will ; elle ne supprime rien.
export interface DepotNotes {
  notesDeContratsFinisAvant(limite: string): Promise<NoteEnFinDeContrat[]>;
  // Vrai si le client a signé un nouveau contrat après la date de fin donnée.
  nouveauContratApres(tenantId: string, finContrat: string): Promise<boolean>;
  // IDEMPOTENTE sur (client, date de fin de contrat) : la même proposition soumise une seconde fois (chaque nuit) ne crée rien.
  // Renvoie vrai si la proposition vient d'être créée, faux si elle existait déjà (l'adaptateur SQL : INSERT … ON CONFLICT (tenant_id, fin_contrat) DO NOTHING).
  soumettreProposition(proposition: PropositionSuppression): Promise<boolean>;
}
export interface ResultatNotes {
  proposees: PropositionSuppression[];
  refusees: { tenantId: string; notes: number; motif: "gel_pour_litige" }[];
}

export async function proposerSuppressionNotes(o: { depot: DepotNotes; gel: GelLitige; journal: JournalRetention; active: boolean; maintenant: Date }): Promise<ResultatNotes> {
  exigerGelReel(o.active, o.gel);
  const limiteDate = new Date(o.maintenant);
  limiteDate.setUTCFullYear(limiteDate.getUTCFullYear() - ANNEES_NOTES);
  const resultat: ResultatNotes = { proposees: [], refusees: [] };
  const parClient = new Map<string, NoteEnFinDeContrat[]>();
  for (const n of await o.depot.notesDeContratsFinisAvant(limiteDate.toISOString().slice(0, 10))) parClient.set(n.tenantId, [...(parClient.get(n.tenantId) ?? []), n]);
  for (const [tenantId, notes] of parClient) {
    const proposition: PropositionSuppression = { tenantId, noteIds: notes.map((n) => n.id), finContrat: notes.reduce((m, n) => (n.finContrat > m ? n.finContrat : m), "") };
    const refuser = async () => {
      resultat.refusees.push({ tenantId, notes: notes.length, motif: "gel_pour_litige" });
      await o.journal({ type: "proposition_notes_refusee", tenantId, notes: notes.length, motif: "gel_pour_litige" });
    };
    if (await o.gel.gelActif(tenantId)) {
      await refuser();
      continue;
    }
    // Un client qui a signé un nouveau contrat depuis n'est pas proposé.
    if (await o.depot.nouveauContratApres(tenantId, proposition.finContrat)) continue;
    if (!o.active) {
      await o.journal({ type: "proposition_notes_prevue_interrupteur_ferme", tenantId, noteIds: proposition.noteIds, finContrat: proposition.finContrat });
      continue;
    }
    // Le gel est relu juste avant la proposition : un gel posé entre-temps l'emporte.
    if (await o.gel.gelActif(tenantId)) {
      await refuser();
      continue;
    }
    // Déjà soumise une nuit précédente : rien de nouveau, rien au journal.
    if (!(await o.depot.soumettreProposition(proposition))) continue;
    resultat.proposees.push(proposition);
    await o.journal({ type: "proposition_suppression_notes", tenantId, noteIds: proposition.noteIds, finContrat: proposition.finContrat });
  }
  return resultat;
}
