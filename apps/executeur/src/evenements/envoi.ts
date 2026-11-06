import { randomUUID } from "node:crypto";
import { Evenement, Paquet } from "@axion-auto/contrats/src/c4/evenements-executeur.ts";
import { EN_TETES, horodatageSuivant, signer } from "@axion-auto/contrats/src/commun/signature.ts";
import type { TamponEvenements } from "./tampon.ts";

const CHEMIN = "/api/executeur/v1/evenements";
export const PAQUET_MAX = 500;
export const VIDAGE_MS = 10_000;
export const SIGNAL_MS = 60_000;

// minutesGagnees = éléments × minutesGagneesParElement du manifeste ; entiers seulement, aucun flottant (A-298).
export function construireFin(v: { instanceId: string; executionId: string; dureeMs: number; elements: number; minutesGagneesParElement: number; jetons: number; coutIaMicroCentimes: number }) {
  const { minutesGagneesParElement, ...reste } = v;
  const minutesGagnees = v.elements * minutesGagneesParElement;
  for (const n of [v.dureeMs, v.elements, minutesGagneesParElement, v.jetons, v.coutIaMicroCentimes, minutesGagnees]) {
    if (!Number.isSafeInteger(n) || n < 0) throw new Error("valeur_non_entiere");
  }
  return { ...reste, minutesGagnees };
}

export interface OptionsEnvoi {
  tampon: TamponEvenements;
  url: string;
  cle: string; // c4:<cellule>:<kid>
  secret: () => string;
  celluleId: string;
  instancesActives: () => readonly string[];
  fetch?: typeof fetch;
  maintenant?: () => number; // secondes Unix
  dormir?: (ms: number) => Promise<void>;
  attentesMs?: readonly number[];
}

export class EnvoiEvenements {
  #dernier: string | undefined;
  constructor(private o: OptionsEnvoi) {}
  // Valide l'événement (schéma strict) puis le garde ; plein à 500, il part tout de suite.
  async envoyer(e: Evenement): Promise<void> {
    if (!this.o.tampon.ajouter(Evenement.parse(e))) throw new Error("tampon_plein");
    if (this.o.tampon.evenements().length >= PAQUET_MAX) await this.vider();
  }
  async signalDeVie(): Promise<void> {
    const a = new Date((this.o.maintenant ?? (() => Date.now() / 1000))() * 1000).toISOString();
    for (const instanceId of this.o.instancesActives()) await this.envoyer({ type: "signal_de_vie", instanceId, celluleId: this.o.celluleId, a });
    await this.vider();
  }
  // Paquets de 500 au plus ; un paquet n'est retiré du tampon que s'il est accepté. Un refus lève, le reste attend le tour suivant.
  async vider(): Promise<void> {
    while (this.o.tampon.evenements().length > 0) {
      const lot = this.o.tampon.evenements().slice(0, PAQUET_MAX);
      await this.#poster(Paquet.parse({ evenements: lot }), randomUUID());
      this.o.tampon.retirer(lot.length);
    }
  }
  // Même Idempotency-Key à chaque essai, mais chaque essai est re-signé. 5xx et réseau sont rejoués ; un 4xx est définitif.
  async #poster(paquet: Paquet, cleIdempotence: string): Promise<void> {
    const corps = JSON.stringify(paquet);
    const attentes = this.o.attentesMs ?? [200, 1000];
    for (let essai = 0; ; essai++) {
      this.#dernier = horodatageSuivant(this.#dernier, (this.o.maintenant ?? (() => Date.now() / 1000))());
      const r = await (this.o.fetch ?? fetch)(`${this.o.url}${CHEMIN}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", [EN_TETES.cle]: this.o.cle, [EN_TETES.horodatage]: this.#dernier, [EN_TETES.signature]: signer(this.o.secret(), this.#dernier, "POST", CHEMIN, corps), [EN_TETES.idempotence]: cleIdempotence },
        body: corps,
        redirect: "error",
        signal: AbortSignal.timeout(5000),
      }).catch(() => undefined);
      if (r?.ok) return;
      if (r && r.status < 500) throw new Error(`console_refus_${r.status}`); // le corps d'un refus n'est jamais repris
      if (essai >= attentes.length) throw new Error("console_injoignable");
      await (this.o.dormir ?? ((ms) => new Promise<void>((fin) => setTimeout(fin, ms))))(attentes[essai]!);
    }
  }
  // Minuteurs de la cellule : vidage toutes les 10 s, signal de vie toutes les 60 s. Rend la fonction d'arrêt. Un échec est ignoré : le tampon garde tout.
  demarrer(): () => void {
    const v = setInterval(() => void this.vider().catch(() => undefined), VIDAGE_MS);
    const s = setInterval(() => void this.signalDeVie().catch(() => undefined), SIGNAL_MS);
    return () => (clearInterval(v), clearInterval(s));
  }
}
