// Port du journal d'audit (C5). La table réelle est créée au lot 2 : ici, l'interface et une version en mémoire.
export interface EntreeAudit {
  action: "blocage_cle" | "levee_blocage_cle" | "levee_budget_jour";
  tenantId?: string;
  parQui: string;
  motif: string;
  montantConsommeMicroCentimes: number;
}
export interface EntreeJournal extends EntreeAudit {
  quand: string;
}
export interface JournalAudit {
  ecrire(entree: EntreeAudit): Promise<void>;
}
export function journalEnMemoire(horloge: () => Date = () => new Date()): JournalAudit & { entrees: EntreeJournal[] } {
  const entrees: EntreeJournal[] = [];
  return {
    entrees,
    async ecrire(e) {
      entrees.push({ ...e, quand: horloge().toISOString() });
    },
  };
}
