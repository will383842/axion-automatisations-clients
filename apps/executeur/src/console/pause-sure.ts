// Pause sûre (A-342) et attente des déclenchements pendant une pause (B-437).
export const UNE_JOURNEE_MS = 24 * 3600_000;

export interface Alertes {
  alerter(code: string, detail?: { instanceId?: string }): void | Promise<void>;
}

// Le temps se compte depuis la dernière réponse de la console, sur une horloge MONOTONE (jamais l'heure du serveur seule).
export class PauseSure {
  #derniere: number;
  #alertee = false;
  readonly #o: { alertes: Alertes; maintenantMs: () => number; delaiMs: number };
  constructor(o: { alertes: Alertes; maintenantMs: () => number; delaiMs?: number }) {
    this.#o = { delaiMs: UNE_JOURNEE_MS, ...o };
    this.#derniere = o.maintenantMs(); // au démarrage, le silence se compte depuis le démarrage
  }
  // La console a répondu : fin de l'épisode, reprise automatique.
  reponseRecue(): void {
    this.#derniere = this.#o.maintenantMs();
    this.#alertee = false;
  }
  // Vrai si la console est muette depuis plus de 24 h ; une seule alerte par épisode.
  evaluer(): boolean {
    if (this.#o.maintenantMs() - this.#derniere <= this.#o.delaiMs) return false;
    if (!this.#alertee) {
      this.#alertee = true;
      void Promise.resolve(this.#o.alertes.alerter("console_muette_pause_sure")).catch(() => undefined);
    }
    return true;
  }
}

// Ordre conservé par instance. La limite n'a pas de défaut : elle vient de la configuration (1 000 en test, [À DÉFINIR] en production).
// Au-delà : refus compté et alerte, jamais d'effacement d'un déclenchement déjà gardé.
export class AttenteEnPause<T> {
  #files = new Map<string, T[]>();
  refuses = 0;
  constructor(
    private limite: number,
    private alertes: Alertes,
  ) {
    if (!Number.isInteger(limite) || limite < 1) throw new Error("limite de la file d'attente invalide");
  }
  taille(instanceId: string): number {
    return this.#files.get(instanceId)?.length ?? 0;
  }
  deposer(instanceId: string, item: T): boolean {
    const file = this.#files.get(instanceId) ?? [];
    if (file.length >= this.limite) {
      this.refuses++;
      void Promise.resolve(this.alertes.alerter("file_pause_pleine", { instanceId })).catch(() => undefined);
      return false;
    }
    file.push(item);
    this.#files.set(instanceId, file);
    return true;
  }
  // Rend les éléments dans l'ordre d'arrivée ; ils sont retirés un par un par `retirer` après leur remise en file.
  enAttente(instanceId: string): readonly T[] {
    return this.#files.get(instanceId) ?? [];
  }
  retirerPremier(instanceId: string): void {
    const file = this.#files.get(instanceId);
    file?.shift();
    if (file?.length === 0) this.#files.delete(instanceId);
  }
}
