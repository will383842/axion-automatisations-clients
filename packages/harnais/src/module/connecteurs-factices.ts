import { ConsoleFactice, type Connecteurs, type Verification } from "@axion-auto/executeur/src/noyau/index.ts";

// Connecteur factice du harnais : aucun réseau, il garde chaque appel arrivé jusqu'à lui (action, entrée) pour que le rapport compte ce qui est sorti.
export interface AppelEnregistre {
  action: string;
  cle: string;
  entree: unknown;
}

export class ConnecteursEnregistres implements Connecteurs {
  appels: AppelEnregistre[] = [];
  #pannes: Error[] = [];
  #faits = new Set<string>();
  programmerPanne(erreur: Error) {
    this.#pannes.push(erreur);
  }
  async appeler(action: string, d: { cle: string; entree: unknown }): Promise<unknown> {
    this.appels.push({ action, cle: d.cle, entree: d.entree });
    const panne = this.#pannes.shift();
    if (panne) throw panne;
    this.#faits.add(d.cle);
    return { ok: true };
  }
  async verifier(_action: string, cle: string): Promise<Verification> {
    return this.#faits.has(cle) ? "trouvee" : "absente";
  }
}

// La console factice du noyau porte le code du module d'exemple : on le remplace par celui du module essayé.
export class ConsoleDuModule extends ConsoleFactice {
  constructor(
    reglages: Record<string, unknown>,
    private module: { code: string; version: string },
  ) {
    super({ reglages });
  }
  override async lireConfiguration(instanceId: string) {
    return { ...(await super.lireConfiguration(instanceId)), moduleCode: this.module.code, moduleVersion: this.module.version };
  }
}
