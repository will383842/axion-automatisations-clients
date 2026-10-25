import type { Connecteurs, Verification } from "../ports.ts";

// Outil simulé : il garde les effets par clé, programme des erreurs et peut forcer sa réponse de vérification.
export class ConnecteurFactice implements Connecteurs {
  appels: { action: string; cle: string }[] = [];
  effetsReels = 0;
  // Vrai pour idempotent_par_cle seulement : les autres garanties ne dédupliquent pas, les doublons doivent se voir.
  dedupliquer = true;
  verification: Verification | undefined;
  surAppel: ((cle: string) => Promise<void>) | undefined;
  #erreurs: Error[] = [];
  #effets = new Set<string>();
  programmer(...erreurs: Error[]) {
    this.#erreurs.push(...erreurs);
  }
  async appeler(action: string, d: { cle: string }): Promise<unknown> {
    this.appels.push({ action, cle: d.cle });
    await this.surAppel?.(d.cle);
    await Promise.resolve();
    const erreur = this.#erreurs.shift();
    if (erreur) throw erreur;
    if (!this.dedupliquer || !this.#effets.has(d.cle)) this.effetsReels++;
    this.#effets.add(d.cle);
    return { ok: true };
  }
  async verifier(_action: string, cle: string): Promise<Verification> {
    return this.verification ?? (this.#effets.has(cle) ? "trouvee" : "absente");
  }
}
