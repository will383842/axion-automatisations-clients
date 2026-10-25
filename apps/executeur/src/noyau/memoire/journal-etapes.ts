import { CLES_JOURNAL, type EntreeJournal, type JournalEtapes } from "../ports.ts";

export class JournalEnMemoire implements JournalEtapes {
  #entrees: EntreeJournal[] = [];
  async inscrire(entree: EntreeJournal): Promise<void> {
    const inconnue = Object.keys(entree).find((k) => !(CLES_JOURNAL as readonly string[]).includes(k));
    if (inconnue) throw new Error(`clé interdite dans le journal : ${inconnue}`);
    this.#entrees.push({ ...entree });
  }
  async lire(instanceId: string, executionId: string): Promise<readonly EntreeJournal[]> {
    return this.#entrees.filter((e) => e.instanceId === instanceId && e.executionId === executionId).map((e) => ({ ...e }));
  }
}
