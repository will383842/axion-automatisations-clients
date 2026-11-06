import type { EtatVoulu } from "@axion-auto/contrats/src/c4/etat-voulu.ts";
import { ErreurRefusConsole } from "./client.ts";
import type { PauseSure } from "./pause-sure.ts";

export interface LectureEtat {
  etat: EtatVoulu["etat"];
  arretEnvois: boolean;
}
export interface PortEtatVoulu {
  lireEtatVoulu(instanceId: string): Promise<EtatVoulu>;
}

// Lu avant CHAQUE exécution. Console injoignable : le dernier état connu sert au plus 24 h depuis la dernière réponse ; au-delà, pause sûre.
// Rien de connu (démarrage à froid) et console muette : pause, rien ne démarre.
export class GardeEtatVoulu {
  #connu = new Map<string, LectureEtat>();
  constructor(private o: { console: PortEtatVoulu; pause: PauseSure; maintenantMs: () => number }) {}
  // Poussée reçue : appliquée sans attendre la prochaine lecture.
  appliquer(instanceId: string, partiel: Partial<LectureEtat>): void {
    this.#connu.set(instanceId, { etat: "pause", arretEnvois: false, ...this.#connu.get(instanceId), ...partiel });
  }
  async lire(instanceId: string): Promise<LectureEtat> {
    try {
      const e = await this.o.console.lireEtatVoulu(instanceId);
      this.o.pause.reponseRecue(instanceId);
      const lu = { etat: e.etat, arretEnvois: e.arretEnvois };
      this.#connu.set(instanceId, lu);
      return lu;
    } catch (e) {
      const connu = this.#connu.get(instanceId);
      // Refus 4xx : la console ne reconnaît plus l'instance. Pause immédiate, jamais le dernier état connu.
      if (e instanceof ErreurRefusConsole) {
        this.#connu.set(instanceId, { etat: "pause", arretEnvois: connu?.arretEnvois ?? false });
        return { etat: "pause", arretEnvois: connu?.arretEnvois ?? false };
      }
      if (this.o.pause.evaluer(instanceId) || !connu) return { etat: "pause", arretEnvois: connu?.arretEnvois ?? false };
      return connu;
    }
  }
}
