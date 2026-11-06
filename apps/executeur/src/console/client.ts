import { Configuration } from "@axion-auto/contrats/src/c4/configuration.ts";
import { EtatVoulu } from "@axion-auto/contrats/src/c4/etat-voulu.ts";
import { EN_TETES, horodatageSuivant, signer } from "@axion-auto/contrats/src/commun/signature.ts";

export interface OptionsClient {
  url: string;
  // X-Axion-Cle : c4:<cellule>:<kid>. Le secret et le jeton sont lus à chaque essai (rotation), jamais gardés ici.
  cle: string;
  secret: () => string;
  jeton: () => string;
  fetch?: typeof fetch;
  maintenant?: () => number; // secondes Unix
  dormir?: (ms: number) => Promise<void>;
  attentesMs?: readonly number[];
}
const CHEMIN = "/api/executeur/v1/instances";

// Client des routes de T4-21. Chaque essai est re-signé (horodatage strictement croissant). Seuls les échecs réseau et les 5xx sont rejoués.
export class ClientConsole {
  #dernier: string | undefined;
  constructor(private o: OptionsClient) {}
  async lireEtatVoulu(instanceId: string): Promise<EtatVoulu> {
    return EtatVoulu.parse(await this.#obtenir(`${CHEMIN}/${encodeURIComponent(instanceId)}/etat-voulu`, false));
  }
  async lireConfiguration(instanceId: string): Promise<Configuration> {
    return Configuration.parse(await this.#obtenir(`${CHEMIN}/${encodeURIComponent(instanceId)}/configuration`, true));
  }
  async #obtenir(chemin: string, avecJeton: boolean): Promise<unknown> {
    const attentes = this.o.attentesMs ?? [200, 1000];
    for (let essai = 0; ; essai++) {
      this.#dernier = horodatageSuivant(this.#dernier, (this.o.maintenant ?? (() => Date.now() / 1000))());
      const entetes: Record<string, string> = {
        [EN_TETES.cle]: this.o.cle,
        [EN_TETES.horodatage]: this.#dernier,
        [EN_TETES.signature]: signer(this.o.secret(), this.#dernier, "GET", chemin, ""),
      };
      if (avecJeton) entetes["Authorization"] = `Instance ${this.o.jeton()}`;
      const r = await (this.o.fetch ?? fetch)(`${this.o.url}${chemin}`, { method: "GET", headers: entetes, redirect: "error", signal: AbortSignal.timeout(5000) }).catch(() => undefined);
      if (r?.ok) return r.json();
      if (r && r.status < 500) throw new Error(`console_refus_${r.status}`); // le corps d'un refus n'est jamais repris
      if (essai >= attentes.length) throw new Error("console_injoignable");
      await (this.o.dormir ?? ((ms) => new Promise<void>((fin) => setTimeout(fin, ms))))(attentes[essai]!);
    }
  }
}
