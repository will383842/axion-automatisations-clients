import { Configuration } from "@axion-auto/contrats/src/c4/configuration.ts";
import { EtatVoulu } from "@axion-auto/contrats/src/c4/etat-voulu.ts";
import { Evenement } from "@axion-auto/contrats/src/c4/evenements-executeur.ts";
import type { Console } from "../ports.ts";

// Console simulée : chaque événement est validé par le schéma strict de C4, donc aucun texte libre ne passe.
export class ConsoleFactice implements Console {
  evenements: Evenement[] = [];
  etat: EtatVoulu["etat"] = "actif";
  constructor(private o: { reglages: Record<string, unknown>; instanceId?: string }) {}
  async lireConfiguration(instanceId: string) {
    return Configuration.parse({ instanceId, moduleCode: "accuse-reception", moduleVersion: "1.0.0", reglages: this.o.reglages, dureeCacheSecondes: 60 });
  }
  async lireEtatVoulu(instanceId: string) {
    return EtatVoulu.parse({ instanceId, etat: this.etat, version: 1 });
  }
  async envoyer(e: Evenement) {
    this.evenements.push(Evenement.parse(e));
  }
  async mettreEnPause() {
    this.etat = "pause";
  }
}
